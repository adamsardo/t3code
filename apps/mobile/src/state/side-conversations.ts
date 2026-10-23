import { createSideConversationEnvironmentAtoms } from "@t3tools/client-runtime/state/side-conversations";
import {
  createSideConversation,
  type SideConversation,
} from "@t3tools/client-runtime/side-conversation-controller";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentThreadDetails } from "./threads";

export const sideConversationEnvironment =
  createSideConversationEnvironmentAtoms(connectionAtomRuntime);
const emptyThreadAtom = Atom.make<EnvironmentThread | null>(null);
const hasCodexContext = (thread: EnvironmentThread | null) =>
  thread !== null &&
  thread.projection.thread.archivedAt === null &&
  thread.projection.thread.deletedAt === null &&
  thread.projection.providerThreads.some(
    (provider) =>
      provider.id === thread.projection.thread.activeProviderThreadId &&
      provider.driver === "codex" &&
      provider.providerInstanceId === thread.projection.thread.providerInstanceId &&
      provider.providerSessionId !== null &&
      provider.nativeThreadRef !== null,
  );

export function useHasSideConversationContext(ref: ScopedThreadRef | null): boolean {
  return useAtomValue(
    ref === null ? emptyThreadAtom : environmentThreadDetails.threadAtom(ref),
    hasCodexContext,
  );
}

async function unwrap<A, E>(result: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const value = await result;
  if (value._tag === "Success") return value.value;
  throw squashAtomCommandFailure(value);
}

export interface SideConversationTab {
  readonly id: string;
  readonly title: string;
  readonly parent: ScopedThreadRef;
  readonly parentTitle: string;
  readonly conversation: SideConversation;
}

interface SideConversationTabs {
  readonly tabs: ReadonlyArray<SideConversationTab>;
  readonly activeId: string | null;
  readonly visible: boolean;
}

// Keep temporary conversations across navigation, without writing them to device storage.
export const sideConversationTabsAtom = Atom.make<SideConversationTabs>({
  tabs: [],
  activeId: null,
  visible: false,
}).pipe(Atom.keepAlive);

export function setSideConversationsVisible(visible: boolean): void {
  appAtomRegistry.set(sideConversationTabsAtom, {
    ...appAtomRegistry.get(sideConversationTabsAtom),
    visible,
  });
}

export function activateSideConversation(activeId: string): void {
  appAtomRegistry.set(sideConversationTabsAtom, {
    ...appAtomRegistry.get(sideConversationTabsAtom),
    activeId,
  });
}

export function removeSideConversation(id: string): void {
  const state = appAtomRegistry.get(sideConversationTabsAtom);
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  appAtomRegistry.set(sideConversationTabsAtom, {
    tabs,
    activeId: state.activeId === id ? (tabs.at(-1)?.id ?? null) : state.activeId,
    visible: tabs.length > 0 && state.visible,
  });
}

export async function openSideConversation(input: {
  readonly parent: ScopedThreadRef;
  readonly parentTitle: string;
  readonly prompt: string;
}): Promise<void> {
  const { parent, parentTitle, prompt } = input;
  const { environmentId } = parent;
  const conversation = createSideConversation(
    {
      open: () =>
        unwrap(
          sideConversationEnvironment.open.run(appAtomRegistry, {
            environmentId,
            input: { threadId: parent.threadId },
          }),
        ),
      send: (conversationId, text, onEvent) =>
        unwrap(
          sideConversationEnvironment.send.run(appAtomRegistry, {
            environmentId,
            input: { conversationId, text },
            onEvent,
          }),
        ),
      interrupt: (conversationId) =>
        unwrap(
          sideConversationEnvironment.interrupt.run(appAtomRegistry, {
            environmentId,
            input: { conversationId },
          }),
        ),
      close: (conversationId) =>
        unwrap(
          sideConversationEnvironment.close.run(appAtomRegistry, {
            environmentId,
            input: { conversationId },
          }),
        ),
    },
    prompt,
  );
  const id = uuidv4();
  const state = appAtomRegistry.get(sideConversationTabsAtom);
  const count = state.tabs.length + 1;
  const tab = {
    id,
    title: count === 1 ? "Side chat" : `Side chat ${count}`,
    parent,
    parentTitle,
    conversation,
  };
  appAtomRegistry.set(sideConversationTabsAtom, {
    tabs: [...state.tabs, tab],
    activeId: id,
    visible: true,
  });
  if (!(await conversation.initialize())) {
    const snapshot = conversation.getSnapshot();
    // A racing close owns removal and must retain the tab if cleanup fails.
    if (snapshot.status === "closing" || snapshot.closed) return;
    removeSideConversation(id);
    throw new Error(snapshot.error ?? "Could not open a side conversation.");
  }
  if (prompt.trim()) void conversation.send();
}
