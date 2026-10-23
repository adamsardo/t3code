import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcStreamCommand } from "./runtime.ts";

export function createSideConversationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:side-conversation:open",
      tag: WS_METHODS.sideConversationOpen,
    }),
    send: createEnvironmentRpcStreamCommand(runtime, {
      label: "environment-command:side-conversation:send",
      tag: WS_METHODS.sideConversationSend,
    }),
    interrupt: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:side-conversation:interrupt",
      tag: WS_METHODS.sideConversationInterrupt,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:side-conversation:close",
      tag: WS_METHODS.sideConversationClose,
    }),
  };
}
