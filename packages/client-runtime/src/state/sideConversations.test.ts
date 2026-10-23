import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type AuthSessionState,
  type SideConversationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSideConversationEnvironmentAtoms } from "./sideConversations.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const environmentId = EnvironmentId.make("side-environment");

const setup = Effect.fn("TestSideConversations.setup")(function* (allowed: boolean) {
  const calls: string[] = [];
  const events: SideConversationEvent[] = [
    { type: "started", turnId: "side-turn" },
    { type: "delta", text: "Inherited " },
    { type: "delta", text: "context" },
    { type: "completed", status: "completed" },
  ];
  const supervisor = {
    target: { environmentId, label: "Side environment" },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.sideConversationOpen]: () =>
            Effect.sync(() => {
              calls.push("open");
              return { conversationId: "child", parentThreadId: ThreadId.make("parent") };
            }),
          [WS_METHODS.sideConversationSend]: () =>
            Stream.suspend(() => {
              calls.push("send");
              return Stream.fromIterable(events);
            }),
          [WS_METHODS.sideConversationInterrupt]: () =>
            Effect.sync(() => {
              calls.push("interrupt");
            }),
          [WS_METHODS.sideConversationClose]: () =>
            Effect.sync(() => {
              calls.push("close");
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      runStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry["Service"]),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  registry.set(
    sessions(environmentId),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: allowed ? [AuthOrchestrationOperateScope] : [],
      permissions: allowed ? [AuthOrchestrationOperateScope] : [],
    }),
  );
  return { commands: createSideConversationEnvironmentAtoms(runtime), registry, calls, events };
});

it.effect("delivers each side response event without coalescing streamed text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { commands, registry, calls, events } = yield* setup(true);
      const received: SideConversationEvent[] = [];
      const result = yield* Effect.promise(() =>
        commands.send.run(registry, {
          environmentId,
          input: { conversationId: "child", text: "What was the context?" },
          onEvent: (event) => received.push(event),
        }),
      );
      expect(result._tag).toBe("Success");
      expect(received).toEqual(events);
      expect(calls).toEqual(["send"]);
    }),
  ),
);

it.effect("blocks every side operation on a connection without the operate grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { commands, registry, calls } = yield* setup(false);
      const target = { environmentId, input: { conversationId: "child" } };
      const results = yield* Effect.promise(() =>
        Promise.all([
          commands.open.run(registry, {
            environmentId,
            input: { threadId: ThreadId.make("parent") },
          }),
          commands.send.run(registry, {
            environmentId,
            input: { conversationId: "child", text: "Do not send" },
            onEvent: () => calls.push("event"),
          }),
          commands.interrupt.run(registry, target),
          commands.close.run(registry, target),
        ]),
      );
      expect(results.map((result) => result._tag)).toEqual([
        "Failure",
        "Failure",
        "Failure",
        "Failure",
      ]);
      expect(calls).toEqual([]);
      expect(registry.get(commands.open.permissionAtom(environmentId))).toBe(false);
      expect(registry.get(commands.send.permissionAtom(environmentId))).toBe(false);
    }),
  ),
);
