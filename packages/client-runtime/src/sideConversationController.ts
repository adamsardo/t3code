import type { SideConversationEvent } from "@t3tools/contracts";

export function parseSideCommand(text: string): string | null {
  const match = /^\/side(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1]?.trim() ?? "") : null;
}

export async function consumeSideCommandDraft(input: {
  readonly commandText: string;
  readonly prompt: string;
  readonly hasNonPromptContent?: boolean;
  readonly open: (prompt: string) => Promise<boolean>;
  readonly readDraft: () => string;
  readonly clearDraft: () => void;
}) {
  if (input.hasNonPromptContent) return "attachments";
  if ((await input.open(input.prompt)) && input.readDraft() === input.commandText) {
    input.clearDraft();
  }
}

export interface SideConversationApi {
  readonly open: () => Promise<{ readonly conversationId: string }>;
  readonly send: (
    conversationId: string,
    text: string,
    onEvent: (event: SideConversationEvent) => void,
  ) => Promise<void>;
  readonly interrupt: (conversationId: string) => Promise<void>;
  readonly close: (conversationId: string) => Promise<void>;
}

export interface SideConversationMessage {
  readonly id: number;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface SideConversationState {
  readonly draft: string;
  readonly messages: ReadonlyArray<SideConversationMessage>;
  readonly status: "opening" | "idle" | "sending" | "interrupting" | "closing";
  readonly error: string | null;
  readonly interrupted: boolean;
  readonly closed: boolean;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The side conversation request failed.";
}

export function createSideConversation(api: SideConversationApi, initialPrompt = "") {
  let state: SideConversationState = {
    draft: initialPrompt,
    messages: [],
    status: "opening",
    error: null,
    interrupted: false,
    closed: false,
  };
  const listeners = new Set<() => void>();
  let conversationId: string | null = null;
  let opening: Promise<void> | null = null;
  let running = false;
  let closing = false;
  let nextMessageId = 0;

  const publish = (patch: Partial<SideConversationState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const open = () => {
    if (conversationId !== null) return Promise.resolve();
    if (opening !== null) return opening;
    publish({ status: "opening", error: null });
    opening = api
      .open()
      .then((result) => {
        conversationId = result.conversationId;
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  };

  const send = async () => {
    const text = state.draft.trim();
    if (state.closed || running || closing || !text) return;
    if (parseSideCommand(text) !== null) {
      publish({ error: "Start another side conversation from the main thread." });
      return;
    }
    running = true;
    publish({ error: null, interrupted: false });
    try {
      await open();
      if (closing || state.closed || conversationId === null) return;
      const assistantId = nextMessageId + 1;
      publish({
        draft: "",
        status: "sending",
        messages: [
          ...state.messages,
          { id: nextMessageId, role: "user", text },
          { id: assistantId, role: "assistant", text: "" },
        ],
      });
      nextMessageId += 2;
      await api.send(conversationId, text, (event) => {
        if (state.closed) return;
        if (event.type === "delta") {
          publish({
            messages: state.messages.map((message) =>
              message.id === assistantId
                ? { ...message, text: message.text + event.text }
                : message,
            ),
          });
        } else if (event.type === "completed") {
          publish({ interrupted: event.status === "interrupted" });
        }
      });
    } catch (error) {
      if (!state.closed) {
        publish({ error: failureMessage(error), draft: state.draft || text });
      }
    } finally {
      running = false;
      if (!state.closed && !closing) publish({ status: "idle" });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft: (draft: string) => publish({ draft }),
    initialize: async () => {
      try {
        await open();
        if (state.closed || closing) return false;
        publish({ status: "idle" });
        return true;
      } catch (error) {
        if (!state.closed && !closing) {
          publish({ status: "idle", error: failureMessage(error) });
        }
        return false;
      }
    },
    send,
    interrupt: async () => {
      if (!running || conversationId === null || closing) return;
      publish({ status: "interrupting", error: null });
      try {
        await api.interrupt(conversationId);
      } catch (error) {
        if (!state.closed && !closing) {
          publish({ status: running ? "sending" : "idle", error: failureMessage(error) });
        }
      }
    },
    close: async (confirmDiscard: () => Promise<boolean>) => {
      if (closing || state.closed) return state.closed;
      if ((state.draft.trim() || state.messages.length > 0) && !(await confirmDiscard())) {
        return false;
      }
      if (closing || state.closed) return state.closed;
      closing = true;
      publish({ status: "closing", error: null });
      try {
        // A close during a fork must dispose the child once its id arrives.
        await opening?.catch(() => undefined);
        if (conversationId !== null) await api.close(conversationId);
        publish({ closed: true });
        return true;
      } catch (error) {
        publish({
          status: running ? "sending" : "idle",
          error: failureMessage(error),
        });
        return false;
      } finally {
        closing = false;
      }
    },
  };
}

export type SideConversation = ReturnType<typeof createSideConversation>;
