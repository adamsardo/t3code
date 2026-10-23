import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  SideConversationError,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as SideConversations from "./SideConversations.ts";

function fixture() {
  const now = DateTime.makeUnsafe(0);
  const threadId = ThreadId.make("parent");
  const instanceId = ProviderInstanceId.make("codex-custom");
  const sessionId = ProviderSessionId.make("parent-session");
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("parent-provider-thread"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: instanceId,
    providerSessionId: sessionId,
    appThreadId: threadId,
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
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Parent",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "selected-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/workspace",
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const opened: Array<Parameters<ProviderSessionManager.ProviderSessionManagerV2Shape["open"]>[0]> =
    [];
  const sideOpens: Array<
    Parameters<NonNullable<ProviderAdapterV2SessionRuntime["sideConversations"]>["open"]>[0]
  > = [];
  const disposed: string[] = [];
  let existing = true;
  let closeFails = false;
  let beforeOpen: Effect.Effect<void> = Effect.void;
  const unexpected = () => Effect.die("Parent mutation must not be called for a side conversation");
  const runtime: ProviderAdapterV2SessionRuntime = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    providerSessionId: sessionId,
    providerSession: {
      id: sessionId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/workspace",
      model: "selected-model",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    events: Stream.empty,
    ensureThread: unexpected,
    resumeThread: unexpected,
    startTurn: unexpected,
    steerTurn: unexpected,
    interruptTurn: unexpected,
    respondToRuntimeRequest: unexpected,
    readThreadSnapshot: unexpected,
    rollbackThread: unexpected,
    forkThread: unexpected,
    sideConversations: {
      hasOpen: Effect.succeed(false),
      open: (input) =>
        Effect.gen(function* () {
          yield* beforeOpen;
          sideOpens.push(input);
          const id = `side-${sideOpens.length}`;
          return {
            id,
            send: (text) => Stream.make({ type: "delta" as const, text }),
            interrupt: Effect.void,
            close: Effect.suspend(() =>
              closeFails
                ? Effect.fail(new SideConversationError({ reason: "close_failed" }))
                : Effect.void,
            ),
            dispose: Effect.sync(() => {
              disposed.push(id);
            }),
          };
        }),
    },
  };
  const layer = SideConversations.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(thread),
          getThreadProviderContext: (_threadId, requestedInstance) => {
            assert.equal(requestedInstance, instanceId);
            return Effect.succeed({
              thread,
              providerThreads: [providerThread],
              providerSessions: [runtime.providerSession],
            });
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: (id) => {
            assert.equal(id, sessionId);
            return Effect.succeed(existing ? Option.some(runtime) : Option.none());
          },
          open: (input) =>
            Effect.sync(() => {
              opened.push(input);
              return runtime;
            }),
        }),
        RuntimePolicy.layer,
      ),
    ),
  );
  return {
    layer,
    thread,
    providerThread,
    runtime,
    opened,
    sideOpens,
    disposed,
    setExisting: (value: boolean) => {
      existing = value;
    },
    setCloseFails: (value: boolean) => {
      closeFails = value;
    },
    setBeforeOpen: (value: Effect.Effect<void>) => {
      beforeOpen = value;
    },
  };
}

it.effect("restores the same provider session and native parent for historical threads", () => {
  const f = fixture();
  f.setExisting(false);
  return Effect.gen(function* () {
    const service = yield* SideConversations.SideConversations;
    const connection = yield* service.connect;
    const result = yield* connection.open({ threadId: f.thread.id });
    assert.deepEqual(result, { conversationId: "side-1", parentThreadId: f.thread.id });
    assert.equal(f.opened.length, 1);
    assert.equal(f.opened[0]!.providerSessionId, f.providerThread.providerSessionId);
    assert.equal(f.opened[0]!.initialNativeThreadId, "native-parent");
    assert.equal(f.opened[0]!.modelSelection.instanceId, f.thread.providerInstanceId);
    assert.equal(f.opened[0]!.resumeFromSession, f.runtime.providerSession);
    assert.equal(f.sideOpens[0]!.providerThread, f.providerThread);
    assert.deepEqual(
      yield* Stream.runCollect(
        connection.send({ conversationId: result.conversationId, text: "question" }),
      ),
      [{ type: "delta", text: "question" }],
    );
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect(
  "keeps conversation IDs private to their owning connection and retries failed close",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* SideConversations.SideConversations;
      const owner = yield* service.connect;
      const stranger = yield* service.connect;
      const side = yield* owner.open({ threadId: f.thread.id });
      assert.equal(
        (yield* Effect.flip(
          Stream.runDrain(stranger.send({ conversationId: side.conversationId, text: "private" })),
        )).reason,
        "not_found",
      );
      assert.equal((yield* Effect.flip(stranger.interrupt(side))).reason, "not_found");
      yield* stranger.close(side);
      f.setCloseFails(true);
      assert.equal((yield* Effect.flip(owner.close(side))).reason, "close_failed");
      yield* owner.interrupt(side);
      f.setCloseFails(false);
      yield* owner.close(side);
      assert.equal((yield* Effect.flip(owner.interrupt(side))).reason, "not_found");
      assert.equal(f.opened.length, 0);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect("rejects archived and unsupported parent threads without opening a native child", () => {
  const archived = fixture();
  const unsupported = fixture();
  Object.assign(archived.thread, { archivedAt: DateTime.makeUnsafe(1) });
  Object.assign(unsupported.providerThread, { driver: ProviderDriverKind.make("claude") });
  return Effect.forEach([archived, unsupported], (f, index) =>
    Effect.gen(function* () {
      const service = yield* SideConversations.SideConversations;
      const connection = yield* service.connect;
      const error = yield* Effect.flip(connection.open({ threadId: f.thread.id }));
      assert.equal(error.reason, index === 0 ? "parent_unavailable" : "unsupported");
      assert.equal(f.sideOpens.length, 0);
      assert.equal(f.opened.length, 0);
    }).pipe(Effect.provide(f.layer), Effect.scoped),
  );
});

it.effect("disconnect disposes a fork that finishes while its socket scope is closing", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.setBeforeOpen(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const scope = yield* Scope.make();
    const service = yield* SideConversations.SideConversations;
    const connection = yield* service.connect.pipe(Scope.provide(scope));
    yield* connection.open({ threadId: f.thread.id }).pipe(Effect.forkIn(scope));
    yield* Deferred.await(started);
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(closing);
    assert.deepEqual(f.disposed, ["side-1"]);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});
