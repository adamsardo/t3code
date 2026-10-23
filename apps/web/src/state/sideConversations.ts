import { createSideConversationEnvironmentAtoms } from "@t3tools/client-runtime/state/side-conversations";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { randomUUID } from "../lib/utils";
import {
  createSideConversation,
  type SideConversation,
} from "@t3tools/client-runtime/side-conversation-controller";

export const sideConversationEnvironment =
  createSideConversationEnvironmentAtoms(connectionAtomRuntime);

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
  readonly cwd: string | undefined;
  readonly conversation: SideConversation;
}

interface SideConversationTabs {
  readonly tabs: ReadonlyArray<SideConversationTab>;
  readonly activeId: string | null;
  readonly visible: boolean;
  readonly hide: () => void;
  readonly show: () => void;
  readonly open: (input: {
    readonly parent: ScopedThreadRef;
    readonly parentTitle: string;
    readonly cwd: string | undefined;
    readonly prompt: string;
  }) => Promise<void>;
  readonly activate: (id: string) => void;
  readonly remove: (id: string) => void;
}

// Temporary tabs survive route changes, but are never persisted to browser or thread storage.
export const useSideConversationTabs = create<SideConversationTabs>((set, get) => ({
  tabs: [],
  activeId: null,
  visible: false,
  hide: () => set({ visible: false }),
  show: () => set({ visible: true }),
  open: async ({ parent, parentTitle, cwd, prompt }) => {
    const environmentId = parent.environmentId;
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
    const id = randomUUID();
    const count = get().tabs.length + 1;
    const tab = {
      id,
      title: count === 1 ? "Side chat" : `Side chat ${count}`,
      parent,
      parentTitle,
      cwd,
      conversation,
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeId: id, visible: true }));
    if (!(await conversation.initialize())) {
      const state = conversation.getSnapshot();
      // A close racing the fork owns removal, including retaining its tab if cleanup fails.
      if (state.status === "closing" || state.closed) return;
      get().remove(id);
      throw new Error(state.error ?? "Could not open a side conversation.");
    }
    if (prompt.trim()) void conversation.send();
  },
  activate: (activeId) => set({ activeId }),
  remove: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      return {
        tabs,
        visible: tabs.length > 0 && state.visible,
        activeId: state.activeId === id ? (tabs.at(-1)?.id ?? null) : state.activeId,
      };
    }),
}));
