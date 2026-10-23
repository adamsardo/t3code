import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeCodexSideConversations } from "./CodexSideConversations.ts";

type Client = CodexClient.CodexAppServerClient["Service"];
type Handler = (payload: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
type OpenInput = Parameters<
  NonNullable<ProviderAdapterV2SessionRuntime["sideConversations"]>["open"]
>[0];
const input: OpenInput = {
  providerThread: {
    id: ProviderThreadId.make("provider-parent"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make("session-parent"),
    appThreadId: ThreadId.make("parent"),
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ProviderDriverKind.make("codex"),
      nativeId: "native-parent",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "selected-model" },
  runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
};

function harness() {
  const notifications = new Map<string, Handler[]>();
  const requests = new Map<string, Handler>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let nextThread = 0;
  let nextTurn = 0;
  let onRequest: (
    method: string,
    params: Record<string, unknown>,
    reply: unknown,
  ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError> = (_method, _params, reply) =>
    Effect.succeed(reply);
  const emit = (method: string, payload: unknown) =>
    Effect.forEach(notifications.get(method) ?? [], (handler) => handler(payload), {
      discard: true,
    });
  // The mock is the SDK boundary: only native fields consumed by this dispatcher are needed.
  const request = ((method: string, params: Record<string, unknown>) =>
    Effect.suspend(() => {
      calls.push({ method, params });
      const reply =
        method === "thread/fork"
          ? { thread: { id: `side-${++nextThread}` } }
          : method === "turn/start"
            ? { turn: { id: `turn-${++nextTurn}` } }
            : {};
      return onRequest(method, params, reply);
    })) as Client["request"];
  const make = (termination?: Client["termination"]) =>
    makeCodexSideConversations((sideInput) =>
      Effect.succeed({
        threadId: sideInput.nativeThreadId,
        input: [{ type: "text" as const, text: sideInput.text, text_elements: [] }],
        model: sideInput.modelSelection.model,
        effort: "high" as const,
        cwd: sideInput.runtimePolicy.cwd,
        approvalPolicy: "never" as const,
      }),
    ).pipe(
      Effect.provide(
        Layer.mock(CodexClient.CodexAppServerClient)({
          raw: {
            notifications: Stream.empty,
            requests: Stream.empty,
            request: () => Effect.die("Unexpected raw request"),
            notify: () => Effect.die("Unexpected raw notification"),
            respond: () => Effect.die("Unexpected raw response"),
            respondError: () => Effect.die("Unexpected raw response"),
          },
          ...(termination ? { termination } : {}),
          request,
          handleServerNotification: (method, handler) =>
            Effect.sync(() => {
              const list = notifications.get(method) ?? [];
              list.push(handler as Handler);
              notifications.set(method, list);
            }),
          handleServerRequest: (method, handler) =>
            Effect.sync(() => {
              requests.set(method, handler as Handler);
            }),
        }),
      ),
    );
  return {
    calls,
    emit,
    make,
    requests,
    setRequest: (handler: typeof onRequest) => {
      onRequest = handler;
    },
  };
}

it.effect("collects completion before turn/start resolves and permits the next side turn", () =>
  Effect.gen(function* () {
    const h = harness();
    h.setRequest((method, params, reply) =>
      method === "turn/start"
        ? Effect.gen(function* () {
            const turn = (reply as { turn: { id: string } }).turn;
            yield* h.emit("item/agentMessage/delta", {
              threadId: params.threadId,
              turnId: turn.id,
              delta: "answer",
            });
            yield* h.emit("turn/completed", {
              threadId: params.threadId,
              turn: { id: turn.id, status: "completed" },
            });
            return reply;
          })
        : Effect.succeed(reply),
    );
    const support = yield* h.make();
    const side = yield* support.open(input);
    for (const turnId of ["turn-1", "turn-2"]) {
      assert.deepEqual(yield* Stream.runCollect(side.send("question")), [
        { type: "started", turnId },
        { type: "delta", text: "answer" },
        { type: "completed", status: "completed" },
      ]);
    }
    const fork = h.calls.find((call) => call.method === "thread/fork")!;
    assert.equal(fork.params.threadId, "native-parent");
    assert.equal(fork.params.ephemeral, true);
    assert.equal(fork.params.excludeTurns, true);
    assert.equal(h.calls.filter((call) => call.method === "turn/interrupt").length, 0);
    const turn = h.calls.find((call) => call.method === "turn/start")!;
    assert.equal(turn.params.model, "selected-model");
    assert.equal(turn.params.effort, "high");
    assert.equal(turn.params.approvalPolicy, "never");
    assert.match(JSON.stringify(turn.params.collaborationMode), /temporary side conversation/);
  }).pipe(Effect.scoped),
);

it.effect("isolates two children, late events and pending forks from parent subagents", () =>
  Effect.gen(function* () {
    const h = harness();
    const support = yield* h.make();
    const parentEvents: unknown[] = [];
    yield* support.parentClient.handleServerNotification("thread/started", (event) =>
      Effect.sync(() => {
        parentEvents.push(event);
      }),
    );
    yield* support.parentClient.handleServerNotification("item/agentMessage/delta", (event) =>
      Effect.sync(() => {
        parentEvents.push(event);
      }),
    );
    h.setRequest((method, _params, reply) =>
      method === "thread/fork"
        ? Effect.gen(function* () {
            const id = (reply as { thread: { id: string } }).thread.id;
            yield* h.emit("thread/started", {
              thread: {
                id: "parent-subagent",
                ephemeral: true,
                parentThreadId: "native-parent",
                forkedFromId: "native-parent",
              },
            });
            yield* h.emit("thread/started", {
              thread: { id, ephemeral: true, parentThreadId: null, forkedFromId: "native-parent" },
            });
            return reply;
          })
        : Effect.succeed(reply),
    );
    const a = yield* support.open(input);
    const b = yield* support.open(input);
    const readyA = yield* Deferred.make<void>();
    const readyB = yield* Deferred.make<void>();
    const fiberA = yield* a.send("A").pipe(
      Stream.tap((event) =>
        event.type === "started" ? Deferred.succeed(readyA, undefined) : Effect.void,
      ),
      Stream.runCollect,
      Effect.forkChild,
    );
    const fiberB = yield* b.send("B").pipe(
      Stream.tap((event) =>
        event.type === "started" ? Deferred.succeed(readyB, undefined) : Effect.void,
      ),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(readyA);
    yield* Deferred.await(readyB);
    yield* h.emit("item/agentMessage/delta", {
      threadId: "native-parent",
      turnId: "parent-turn",
      delta: "parent",
    });
    yield* h.emit("item/agentMessage/delta", { threadId: a.id, turnId: "turn-1", delta: "A" });
    yield* h.emit("item/agentMessage/delta", { threadId: b.id, turnId: "turn-2", delta: "B" });
    yield* h.emit("turn/completed", {
      threadId: a.id,
      turn: { id: "old-turn", status: "completed" },
    });
    yield* h.emit("turn/completed", {
      threadId: a.id,
      turn: { id: "turn-1", status: "completed" },
    });
    yield* h.emit("turn/completed", {
      threadId: b.id,
      turn: { id: "turn-2", status: "completed" },
    });
    assert.deepEqual(
      (yield* Fiber.join(fiberA)).filter((event) => event.type === "delta"),
      [{ type: "delta", text: "A" }],
    );
    assert.deepEqual(
      (yield* Fiber.join(fiberB)).filter((event) => event.type === "delta"),
      [{ type: "delta", text: "B" }],
    );
    yield* a.close;
    yield* h.emit("item/agentMessage/delta", { threadId: a.id, turnId: "turn-1", delta: "late" });
    assert.equal(parentEvents.length, 3);
    assert.equal(yield* support.hasOpen, true);
    yield* b.close;
    assert.equal(yield* support.hasOpen, false);
  }).pipe(Effect.scoped),
);

it.effect("cancelling the response interrupts only its native child", () =>
  Effect.gen(function* () {
    const h = harness();
    const support = yield* h.make();
    const side = yield* support.open(input);
    const ready = yield* Deferred.make<void>();
    const fiber = yield* side.send("question").pipe(
      Stream.tap((event) =>
        event.type === "started" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* Fiber.interrupt(fiber);
    assert.deepEqual(
      h.calls.filter((call) => call.method === "turn/interrupt"),
      [{ method: "turn/interrupt", params: { threadId: side.id, turnId: "turn-1" } }],
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps failed close retryable but releases a discarded connection on failure", () =>
  Effect.gen(function* () {
    const h = harness();
    let failUnsubscribe = true;
    h.setRequest((method, _params, reply) =>
      method === "thread/unsubscribe" && failUnsubscribe
        ? Effect.fail(CodexErrors.CodexAppServerRequestError.internalError("temporary"))
        : Effect.succeed(reply),
    );
    const support = yield* h.make();
    const side = yield* support.open(input);
    assert.equal((yield* Effect.flip(side.close)).reason, "close_failed");
    assert.equal(yield* support.hasOpen, true);
    failUnsubscribe = false;
    yield* side.close;
    assert.equal(yield* support.hasOpen, false);
    const other = yield* support.open(input);
    failUnsubscribe = true;
    yield* other.dispose;
    assert.equal(yield* support.hasOpen, false);
  }).pipe(Effect.scoped),
);

it.effect("fails active responses when the native server exits and permits discard", () =>
  Effect.gen(function* () {
    const h = harness();
    const terminated = yield* Deferred.make<CodexErrors.CodexAppServerError>();
    const support = yield* h.make(Deferred.await(terminated));
    const side = yield* support.open(input);
    const ready = yield* Deferred.make<void>();
    const fiber = yield* side.send("question").pipe(
      Stream.tap((event) =>
        event.type === "started" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* Deferred.succeed(
      terminated,
      new CodexErrors.CodexAppServerProcessExitedError({ code: 1 }),
    );
    assert.equal((yield* Effect.flip(Fiber.join(fiber))).reason, "provider_failure");
    assert.equal(yield* support.hasOpen, false);
    yield* side.close;
    assert.equal(h.calls.filter((call) => call.method === "thread/unsubscribe").length, 0);
  }).pipe(Effect.scoped),
);

it.effect("rejects child interactive requests without invoking parent request handlers", () =>
  Effect.gen(function* () {
    const h = harness();
    const support = yield* h.make();
    let parentRequests = 0;
    yield* support.parentClient.handleServerRequest("item/tool/requestUserInput", () =>
      Effect.sync(() => {
        parentRequests++;
        return { answers: {} };
      }),
    );
    const side = yield* support.open(input);
    const ready = yield* Deferred.make<void>();
    const fiber = yield* side.send("question").pipe(
      Stream.tap((event) =>
        event.type === "started" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(h.requests.get("item/tool/requestUserInput")!({ threadId: side.id })),
      ),
    );
    assert.equal((yield* Effect.flip(Fiber.join(fiber))).reason, "request_unavailable");
    assert.equal(parentRequests, 0);
  }).pipe(Effect.scoped),
);

it.effect("separates assistant items while preserving chunks and filtering other turns", () =>
  Effect.gen(function* () {
    const h = harness();
    h.setRequest((method, params, reply) =>
      method === "turn/start"
        ? Effect.gen(function* () {
            const turn = (reply as { turn: { id: string } }).turn;
            for (const delta of [
              { turnId: turn.id, itemId: "commentary", delta: "I'll inspect" },
              { turnId: "old-turn", itemId: "other-item", delta: "ignored" },
              { turnId: turn.id, itemId: "commentary", delta: "." },
              { turnId: turn.id, itemId: "final", delta: "The result" },
              { turnId: turn.id, itemId: "final", delta: " is ready." },
            ]) {
              yield* h.emit("item/agentMessage/delta", { threadId: params.threadId, ...delta });
            }
            yield* h.emit("turn/completed", {
              threadId: params.threadId,
              turn: { id: turn.id, status: "completed" },
            });
            return reply;
          })
        : Effect.succeed(reply),
    );
    const support = yield* h.make();
    const side = yield* support.open(input);
    for (const question of ["question", "follow-up"]) {
      const events = yield* Stream.runCollect(side.send(question));
      assert.deepEqual(
        events.filter((event) => event.type === "delta"),
        [
          { type: "delta", text: "I'll inspect" },
          { type: "delta", text: "." },
          { type: "delta", text: "\n\nThe result" },
          { type: "delta", text: " is ready." },
        ],
      );
    }
  }).pipe(Effect.scoped),
);
