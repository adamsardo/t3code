import {
  SideConversationError,
  type SideConversationEvent,
  type SideConversationOpened,
  type SideConversationOpenInput,
  type SideConversationSendInput,
  type SideConversationTarget,
} from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";

type SideRuntime = Effect.Success<
  ReturnType<NonNullable<ProviderAdapterV2SessionRuntime["sideConversations"]>["open"]>
>;

interface SideConversationConnection {
  readonly open: (
    input: SideConversationOpenInput,
  ) => Effect.Effect<SideConversationOpened, SideConversationError>;
  readonly send: (
    input: SideConversationSendInput,
  ) => Stream.Stream<SideConversationEvent, SideConversationError>;
  readonly interrupt: (input: SideConversationTarget) => Effect.Effect<void, SideConversationError>;
  readonly close: (input: SideConversationTarget) => Effect.Effect<void, SideConversationError>;
}

export class SideConversations extends Context.Service<
  SideConversations,
  {
    readonly connect: Effect.Effect<SideConversationConnection, never, Scope.Scope>;
  }
>()("t3/provider/SideConversations") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const policies = yield* RuntimePolicy.RuntimePolicyV2;
  return SideConversations.of({
    connect: Effect.gen(function* () {
      // Each authenticated socket owns its temporary native conversations.
      const openSides = new Map<string, SideRuntime>();
      yield* Effect.addFinalizer(() =>
        Effect.forEach(openSides.values(), (side) => side.dispose, {
          discard: true,
        }),
      );

      const find = Effect.fn("SideConversations.find")(function* (input: SideConversationTarget) {
        const side = openSides.get(input.conversationId);
        if (!side) return yield* new SideConversationError({ reason: "not_found" });
        return side;
      });

      return {
        open: Effect.fn("SideConversations.open")(function* ({ threadId }) {
          const thread = yield* projections
            .getThread(threadId)
            .pipe(
              Effect.mapError(
                (cause) => new SideConversationError({ reason: "parent_unavailable", cause }),
              ),
            );
          if (thread.archivedAt !== null || thread.deletedAt !== null)
            return yield* new SideConversationError({ reason: "parent_unavailable" });
          const context = yield* projections
            .getThreadProviderContext(threadId, thread.providerInstanceId)
            .pipe(
              Effect.mapError(
                (cause) => new SideConversationError({ reason: "parent_unavailable", cause }),
              ),
            );
          const providerThread = context.providerThreads.find(
            (candidate) => candidate.id === thread.activeProviderThreadId,
          );
          if (
            !providerThread ||
            !providerThread.providerSessionId ||
            !providerThread.nativeThreadRef?.nativeId
          ) {
            return yield* new SideConversationError({ reason: "parent_unavailable" });
          }
          if (
            providerThread.driver !== "codex" ||
            providerThread.providerInstanceId !== thread.providerInstanceId
          ) {
            return yield* new SideConversationError({ reason: "unsupported" });
          }
          const policy = yield* policies
            .resolve({ thread, modelSelection: thread.modelSelection })
            .pipe(
              Effect.mapError(
                (cause) => new SideConversationError({ reason: "parent_unavailable", cause }),
              ),
            );
          const existing = yield* sessions
            .get(providerThread.providerSessionId)
            .pipe(
              Effect.mapError(
                (cause) => new SideConversationError({ reason: "parent_unavailable", cause }),
              ),
            );
          const priorSession = context.providerSessions.find(
            (candidate) => candidate.id === providerThread.providerSessionId,
          );
          const runtime = Option.isSome(existing)
            ? existing.value
            : yield* sessions
                .open({
                  threadId,
                  providerSessionId: providerThread.providerSessionId,
                  modelSelection: thread.modelSelection,
                  runtimePolicy: policy,
                  ...(priorSession ? { resumeFromSession: priorSession } : {}),
                  initialNativeThreadId: providerThread.nativeThreadRef.nativeId,
                })
                .pipe(
                  Effect.mapError(
                    (cause) => new SideConversationError({ reason: "parent_unavailable", cause }),
                  ),
                );
          if (!runtime.sideConversations)
            return yield* new SideConversationError({ reason: "unsupported" });
          return yield* Effect.gen(function* () {
            const side = yield* runtime.sideConversations!.open({
              providerThread,
              modelSelection: thread.modelSelection,
              runtimePolicy: policy,
            });
            openSides.set(side.id, side);
            return { conversationId: side.id, parentThreadId: threadId };
          }).pipe(Effect.uninterruptible);
        }),
        send: (input) =>
          Stream.unwrap(find(input).pipe(Effect.map((side) => side.send(input.text)))),
        interrupt: Effect.fn("SideConversations.interrupt")(function* (input) {
          yield* (yield* find(input)).interrupt;
        }),
        close: Effect.fn("SideConversations.close")(function* (input) {
          const side = openSides.get(input.conversationId);
          if (!side) return;
          yield* side.close;
          openSides.delete(input.conversationId);
        }),
      } satisfies SideConversationConnection;
    }),
  });
});

export const layer = Layer.effect(SideConversations, make);
