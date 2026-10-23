import { SideConversationError, type SideConversationEvent } from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

const SIDE_CONVERSATION_INSTRUCTIONS = `You are answering a temporary side conversation. The inherited conversation is reference context only. Do not continue its unfinished work or treat its requests as instructions for this conversation. Respond only to new user messages in this side conversation. Do not create or delegate to subagents, schedule future work, or send updates to other conversations. Inherited tool calls and approvals do not authorize new actions here. You may inspect information, but do not change files, applications, or external state unless a new user message in this side conversation explicitly requests that action. Do not send results to, resume, or otherwise modify the parent conversation.`;

type SideSupport = NonNullable<ProviderAdapterV2SessionRuntime["sideConversations"]>;
type SideRuntime = Effect.Success<ReturnType<SideSupport["open"]>>;
type SideOpenInput = Parameters<SideSupport["open"]>[0];
type NativeSideEvent =
  | {
      readonly type: "delta";
      readonly turnId: string;
      readonly itemId: string;
      readonly text: string;
    }
  | {
      readonly type: "completed";
      readonly turnId: string;
      readonly status: "completed" | "interrupted" | "failed";
    };
type EventQueue = Queue.Queue<NativeSideEvent, SideConversationError | Cause.Done>;

interface OpenSide {
  readonly runtime: SideRuntime;
  queue: EventQueue | null;
  turnId: string | null;
  lastStartedTurnId: string | null;
  lastCompletedTurnId: string | null;
  closing: boolean;
  closed: boolean;
}

/** One dispatcher per native session; handlers never consume the parent's event stream. */
export const makeCodexSideConversations = Effect.fn("CodexSideConversations.make")(function* (
  buildTurnParams: (
    input: SideOpenInput & { readonly nativeThreadId: string; readonly text: string },
  ) => Effect.Effect<CodexSchema.V2TurnStartParams, Schema.SchemaError>,
) {
  const client = yield* CodexClient.CodexAppServerClient;
  const sides = new Map<string, OpenSide>();
  // Retain identity until native session shutdown, so late child events cannot
  // enter the parent's projection buffers after the side panel is discarded.
  const ownedThreadIds = new Set<string>();
  const pendingForkSources = new Map<string, number>();
  const claimPendingFork = (thread: Record<string, unknown>) => {
    if (
      typeof thread.id === "string" &&
      thread.ephemeral === true &&
      thread.parentThreadId == null &&
      typeof thread.forkedFromId === "string" &&
      pendingForkSources.has(thread.forkedFromId)
    )
      ownedThreadIds.add(thread.id);
  };
  const sideThreadId = (payload: unknown): string | null => {
    if (typeof payload !== "object" || payload === null) return null;
    const record = payload as Record<string, unknown>;
    const candidate = record.threadId ?? record.conversationId;
    if (typeof candidate === "string") return ownedThreadIds.has(candidate) ? candidate : null;
    const thread = record.thread;
    if (
      typeof thread === "object" &&
      thread !== null &&
      "id" in thread &&
      typeof thread.id === "string"
    ) {
      claimPendingFork(thread as Record<string, unknown>);
      return ownedThreadIds.has(thread.id) ? thread.id : null;
    }
    return null;
  };
  const parentClient: CodexClient.CodexAppServerClient["Service"] = {
    ...client,
    handleServerNotification: (method, handler) =>
      client.handleServerNotification(method, (payload) =>
        sideThreadId(payload) === null ? handler(payload) : Effect.void,
      ),
    handleServerRequest: (method, handler) =>
      client.handleServerRequest(method, (payload) => {
        const threadId = sideThreadId(payload);
        if (threadId === null) return handler(payload);
        const side = sides.get(threadId);
        return Effect.gen(function* () {
          if (side?.queue)
            yield* Queue.fail(
              side.queue,
              new SideConversationError({ reason: "request_unavailable" }),
            );
          // Refuse instead of borrowing a parent approval or waiting for a parent
          // turn context that does not exist for an ephemeral child.
          return yield* CodexErrors.CodexAppServerRequestError.internalError(
            "Interactive requests are not supported in temporary side conversations.",
          );
        });
      }),
  };

  yield* client.handleServerNotification("thread/started", (event) => {
    claimPendingFork(event.thread);
    return Effect.void;
  });

  yield* client.handleServerNotification("item/agentMessage/delta", (event) => {
    const side = sides.get(event.threadId);
    return side?.queue
      ? Queue.offer(side.queue, {
          type: "delta",
          turnId: event.turnId,
          itemId: event.itemId,
          text: event.delta,
        }).pipe(Effect.asVoid)
      : Effect.void;
  });
  yield* client.handleServerNotification("turn/completed", (event) => {
    const side = sides.get(event.threadId);
    if (!side) return Effect.void;
    side.lastCompletedTurnId = event.turn.id;
    if (side.turnId === event.turn.id) side.turnId = null;
    if (!side.queue) return Effect.void;
    const queue = side.queue;
    return Queue.offer(queue, {
      type: "completed",
      turnId: event.turn.id,
      status:
        event.turn.status === "failed"
          ? "failed"
          : event.turn.status === "interrupted"
            ? "interrupted"
            : "completed",
    }).pipe(Effect.asVoid);
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sides.values(),
      (side) =>
        Effect.gen(function* () {
          side.closed = true;
          if (side.queue) {
            yield* Queue.fail(side.queue, new SideConversationError({ reason: "closed" }));
          }
        }),
      { discard: true },
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          sides.clear();
          ownedThreadIds.clear();
        }),
      ),
    ),
  );

  const expire = Effect.fn("CodexSideConversations.expire")(function* (id: string, side: OpenSide) {
    side.closed = true;
    side.turnId = null;
    sides.delete(id);
    if (side.queue)
      yield* Queue.fail(side.queue, new SideConversationError({ reason: "provider_failure" }));
  });
  if (client.termination) {
    yield* client.termination.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          Effect.forEach(sides, ([id, side]) => expire(id, side), { discard: true }),
        ),
      ),
      Effect.forkScoped,
    );
  }

  const open: SideSupport["open"] = Effect.fn("CodexSideConversations.open")(function* (input) {
    const sourceId = input.providerThread.nativeThreadRef?.nativeId;
    if (!sourceId) return yield* new SideConversationError({ reason: "parent_unavailable" });
    return yield* Effect.gen(function* () {
      pendingForkSources.set(sourceId, (pendingForkSources.get(sourceId) ?? 0) + 1);
      const fork = yield* client
        .request("thread/fork", {
          threadId: sourceId,
          ephemeral: true,
          excludeTurns: true,
          threadSource: "user",
          model: input.modelSelection.model,
          ...(input.runtimePolicy.cwd ? { cwd: input.runtimePolicy.cwd } : {}),
          developerInstructions: SIDE_CONVERSATION_INSTRUCTIONS,
          config: {
            "features.multi_agent": false,
            "features.multi_agent_v2": false,
          },
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const remaining = (pendingForkSources.get(sourceId) ?? 1) - 1;
              if (remaining === 0) pendingForkSources.delete(sourceId);
              else pendingForkSources.set(sourceId, remaining);
            }),
          ),
          Effect.tapError((cause) => Effect.logWarning("side-conversation.fork-failed", { cause })),
          Effect.mapError(
            (cause) => new SideConversationError({ reason: "provider_failure", cause }),
          ),
        );
      const id = fork.thread.id;
      ownedThreadIds.add(id);
      const turnStartLock = yield* Semaphore.make(1);
      const closeLock = yield* Semaphore.make(1);
      const side: OpenSide = {
        runtime: {
          id,
          send: (text) =>
            Stream.unwrap(
              Effect.gen(function* () {
                if (side.closed || side.closing)
                  return yield* new SideConversationError({ reason: "closed" });
                if (side.queue || side.turnId)
                  return yield* new SideConversationError({ reason: "busy" });
                const queue = yield* Queue.unbounded<
                  NativeSideEvent,
                  SideConversationError | Cause.Done
                >();
                side.queue = queue;
                yield* Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    // Cancelling the RPC stream must stop only its own native turn.
                    if (side.turnId !== null && !side.closed) {
                      yield* side.runtime.interrupt.pipe(Effect.ignore);
                    }
                    if (side.queue === queue) side.queue = null;
                  }),
                );
                const started = yield* turnStartLock.withPermit(
                  Effect.gen(function* () {
                    if (side.closed || side.closing)
                      return yield* new SideConversationError({ reason: "closed" });
                    const params = yield* buildTurnParams({
                      ...input,
                      nativeThreadId: id,
                      text,
                    }).pipe(
                      Effect.mapError(
                        (cause) => new SideConversationError({ reason: "provider_failure", cause }),
                      ),
                    );
                    const turnParams = {
                      ...params,
                      collaborationMode: {
                        mode: input.runtimePolicy.interactionMode === "plan" ? "plan" : "default",
                        settings: {
                          model: input.modelSelection.model,
                          ...(params.effort === undefined
                            ? {}
                            : { reasoning_effort: params.effort }),
                          developer_instructions: SIDE_CONVERSATION_INSTRUCTIONS,
                        },
                      },
                    };
                    const response = yield* client
                      .request("turn/start", turnParams)
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new SideConversationError({ reason: "provider_failure", cause }),
                        ),
                      );
                    side.lastStartedTurnId = response.turn.id;
                    // Some providers emit completion before the turn/start response.
                    side.turnId =
                      side.lastCompletedTurnId === response.turn.id ? null : response.turn.id;
                    return response;
                  }).pipe(Effect.uninterruptible),
                );
                let lastMessageItemId: string | null = null;
                return Stream.concat(
                  Stream.make({ type: "started" as const, turnId: started.turn.id }),
                  Stream.fromQueue(queue).pipe(
                    Stream.filter((event) => event.turnId === started.turn.id),
                    Stream.takeUntil((event) => event.type === "completed"),
                    Stream.mapEffect(
                      (event): Effect.Effect<SideConversationEvent, SideConversationError> => {
                        if (event.type === "delta") {
                          const separator =
                            lastMessageItemId !== null && lastMessageItemId !== event.itemId
                              ? "\n\n"
                              : "";
                          lastMessageItemId = event.itemId;
                          return Effect.succeed({ type: "delta", text: separator + event.text });
                        }
                        return event.status === "failed"
                          ? Effect.fail(new SideConversationError({ reason: "provider_failure" }))
                          : Effect.succeed({ type: "completed", status: event.status });
                      },
                    ),
                  ),
                );
              }),
            ),
          interrupt: Effect.gen(function* () {
            yield* turnStartLock
              .withPermit(
                Effect.gen(function* () {
                  if (side.closed || side.turnId === null) return;
                  yield* client
                    .request("turn/interrupt", { threadId: id, turnId: side.turnId })
                    .pipe(
                      Effect.catchTags({
                        CodexAppServerProcessExitedError: () => expire(id, side),
                        CodexAppServerInputStreamEndedError: () => expire(id, side),
                        CodexAppServerTransportError: () => expire(id, side),
                      }),
                    );
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) => new SideConversationError({ reason: "provider_failure", cause }),
                ),
              );
          }).pipe(Effect.withSpan("CodexSideConversations.interrupt")),
          close: closeLock.withPermit(
            Effect.gen(function* () {
              if (side.closed) return;
              side.closing = true;
              yield* Effect.gen(function* () {
                yield* side.runtime.interrupt;
                if (side.closed) return;
                yield* client.request("thread/unsubscribe", { threadId: id }).pipe(
                  Effect.catchTags({
                    CodexAppServerProcessExitedError: () => expire(id, side),
                    CodexAppServerInputStreamEndedError: () => expire(id, side),
                    CodexAppServerTransportError: () => expire(id, side),
                  }),
                );
                side.closed = true;
                side.turnId = null;
                if (side.queue) {
                  yield* Queue.offer(side.queue, {
                    type: "completed",
                    turnId: side.lastStartedTurnId ?? "",
                    status: "interrupted",
                  });
                  yield* Queue.end(side.queue);
                }
                sides.delete(id);
              }).pipe(
                Effect.mapError(
                  (cause) => new SideConversationError({ reason: "close_failed", cause }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    side.closing = false;
                  }),
                ),
              );
            }).pipe(Effect.withSpan("CodexSideConversations.close")),
          ),
          dispose: Effect.gen(function* () {
            if (side.closed) return;
            side.closing = true;
            // Try both operations. An unreachable child must not pin an idle parent.
            yield* side.runtime.interrupt.pipe(Effect.ignore);
            yield* client
              .request("thread/unsubscribe", { threadId: id })
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("side-conversation.dispose-failed", { cause }),
                ),
              );
            side.closed = true;
            side.turnId = null;
            sides.delete(id);
            if (side.queue)
              yield* Queue.fail(side.queue, new SideConversationError({ reason: "closed" }));
          }).pipe(Effect.withSpan("CodexSideConversations.dispose")),
        },
        queue: null,
        turnId: null,
        lastStartedTurnId: null,
        lastCompletedTurnId: null,
        closing: false,
        closed: false,
      };
      sides.set(id, side);
      yield* client
        .request("thread/inject_items", {
          threadId: id,
          items: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: SIDE_CONVERSATION_INSTRUCTIONS }],
            },
          ],
        })
        .pipe(
          Effect.onError(() => side.runtime.dispose),
          Effect.mapError(
            (cause) => new SideConversationError({ reason: "provider_failure", cause }),
          ),
        );
      return side.runtime;
    }).pipe(Effect.uninterruptible);
  });
  return {
    open,
    hasOpen: Effect.sync(() => sides.size > 0 || pendingForkSources.size > 0),
    parentClient,
  } satisfies SideSupport & { parentClient: CodexClient.CodexAppServerClient["Service"] };
});
