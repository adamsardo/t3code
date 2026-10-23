import { describe, expect, it, vi } from "vite-plus/test";
import type { SideConversationEvent } from "@t3tools/contracts";

import {
  consumeSideCommandDraft,
  createSideConversation,
  parseSideCommand,
  type SideConversationApi,
} from "./sideConversationController.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const started = deferred<void>();
  const turn = deferred<void>();
  let emit: ((event: SideConversationEvent) => void) | undefined;
  const api = {
    open: vi.fn(async () => ({ conversationId: "side-1" })),
    send: vi.fn<SideConversationApi["send"]>((_id, _text, onEvent) => {
      emit = onEvent;
      started.resolve();
      return turn.promise;
    }),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } satisfies SideConversationApi;
  return { api, started, turn, emit: (event: SideConversationEvent) => emit?.(event) };
}

describe("parseSideCommand", () => {
  it.each([
    ["/side", ""],
    ["  /side  ", ""],
    ["/side Explain this decision", "Explain this decision"],
    ["/side\nFirst line\nSecond line", "First line\nSecond line"],
    ["/sideways", null],
    ["/SIDE", null],
    ["/Side Explain", null],
    ["What does /side do?", null],
    ["`/side`", null],
  ])("parses %j without consuming ordinary prompts", (input, expected) => {
    expect(parseSideCommand(input)).toBe(expected);
  });
});

describe("side command draft", () => {
  it("clears the original main draft only after the fork succeeds", async () => {
    const fork = deferred<boolean>();
    let draft = "/side Explain";
    const consumed = consumeSideCommandDraft({
      commandText: draft,
      prompt: "Explain",
      open: () => fork.promise,
      readDraft: () => draft,
      clearDraft: () => {
        draft = "";
      },
    });
    expect(draft).toBe("/side Explain");
    fork.resolve(true);
    await consumed;
    expect(draft).toBe("");
  });

  it("preserves the main draft when the fork fails", async () => {
    let draft = "/side Explain";
    await consumeSideCommandDraft({
      commandText: draft,
      prompt: "Explain",
      open: async () => false,
      readDraft: () => draft,
      clearDraft: () => {
        draft = "";
      },
    });
    expect(draft).toBe("/side Explain");
  });

  it("preserves edits made in the main composer while the fork is pending", async () => {
    const fork = deferred<boolean>();
    let draft = "/side Explain";
    const consumed = consumeSideCommandDraft({
      commandText: draft,
      prompt: "Explain",
      open: () => fork.promise,
      readDraft: () => draft,
      clearDraft: () => {
        draft = "";
      },
    });
    draft = "Continue the main task";
    fork.resolve(true);
    await consumed;
    expect(draft).toBe("Continue the main task");
  });
});

describe("side conversation lifecycle", () => {
  it("forks when opened, with an empty transcript until a side message is sent", async () => {
    const { api } = setup();
    const conversation = createSideConversation(api);
    await conversation.initialize();
    expect(api.open).toHaveBeenCalledOnce();
    expect(conversation.getSnapshot().messages).toEqual([]);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("streams only side messages and keeps follow-ups in the same child", async () => {
    const { api, started, turn, emit } = setup();
    const conversation = createSideConversation(api, "Explain this decision");
    await conversation.initialize();
    const sent = conversation.send();
    await started.promise;
    emit({ type: "delta", text: "The decision " });
    emit({ type: "delta", text: "uses the main context." });
    expect(conversation.getSnapshot().messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Explain this decision" },
      { role: "assistant", text: "The decision uses the main context." },
    ]);
    emit({ type: "completed", status: "completed" });
    turn.resolve();
    await sent;
    conversation.setDraft("Why?");
    await conversation.send();
    expect(api.open).toHaveBeenCalledOnce();
    expect(api.send).toHaveBeenLastCalledWith("side-1", "Why?", expect.any(Function));
  });

  it("preserves a cancelled close and discards only after server cleanup succeeds", async () => {
    const { api } = setup();
    const conversation = createSideConversation(api);
    await conversation.initialize();
    conversation.setDraft("Keep this draft");
    expect(await conversation.close(async () => false)).toBe(false);
    expect(conversation.getSnapshot().draft).toBe("Keep this draft");
    expect(api.close).not.toHaveBeenCalled();
    api.close.mockRejectedValueOnce(new Error("Could not unsubscribe"));
    expect(await conversation.close(async () => true)).toBe(false);
    expect(conversation.getSnapshot()).toMatchObject({
      draft: "Keep this draft",
      closed: false,
      error: "Could not unsubscribe",
    });
    expect(await conversation.close(async () => true)).toBe(true);
    expect(conversation.getSnapshot().closed).toBe(true);
  });

  it("closes an empty conversation without confirmation", async () => {
    const { api } = setup();
    const conversation = createSideConversation(api);
    await conversation.initialize();
    const confirm = vi.fn(async () => false);
    expect(await conversation.close(confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledWith("side-1");
  });

  it("waits for an in-flight fork before disposing a blank tab", async () => {
    const { api } = setup();
    const fork = deferred<{ conversationId: string }>();
    api.open.mockImplementation(() => fork.promise);
    const conversation = createSideConversation(api);
    const initialized = conversation.initialize();
    const closed = conversation.close(async () => true);
    expect(conversation.getSnapshot().status).toBe("closing");
    fork.resolve({ conversationId: "late-child" });
    await initialized;
    expect(await closed).toBe(true);
    expect(api.close).toHaveBeenCalledWith("late-child");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("retains a child when cleanup fails after closing during a fork", async () => {
    const { api } = setup();
    const fork = deferred<{ conversationId: string }>();
    api.open.mockImplementation(() => fork.promise);
    api.close.mockRejectedValueOnce(new Error("Cleanup failed"));
    const conversation = createSideConversation(api);
    const initialized = conversation.initialize();
    const closed = conversation.close(async () => true);
    fork.resolve({ conversationId: "late-child" });
    expect(await initialized).toBe(false);
    expect(await closed).toBe(false);
    expect(conversation.getSnapshot()).toMatchObject({
      closed: false,
      status: "idle",
      error: "Cleanup failed",
    });
    expect(await conversation.close(async () => true)).toBe(true);
  });

  it("stops a side turn without losing its transcript", async () => {
    const { api, started, turn, emit } = setup();
    const conversation = createSideConversation(api, "Explain");
    await conversation.initialize();
    const sent = conversation.send();
    await started.promise;
    emit({ type: "delta", text: "Partial answer" });
    await conversation.interrupt();
    expect(api.interrupt).toHaveBeenCalledWith("side-1");
    emit({ type: "completed", status: "interrupted" });
    turn.resolve();
    await sent;
    expect(conversation.getSnapshot()).toMatchObject({ status: "idle", interrupted: true });
    expect(conversation.getSnapshot().messages[1]?.text).toBe("Partial answer");
  });

  it("retains a failed initial prompt and reports errors", async () => {
    const { api } = setup();
    api.open.mockRejectedValueOnce(new Error("Parent thread unavailable"));
    const conversation = createSideConversation(api, "Explain");
    expect(await conversation.initialize()).toBe(false);
    expect(conversation.getSnapshot()).toMatchObject({
      draft: "Explain",
      status: "idle",
      error: "Parent thread unavailable",
    });
    expect(api.send).not.toHaveBeenCalled();
  });

  it("restores a side question when sending fails after the fork succeeds", async () => {
    const { api, started, turn } = setup();
    const conversation = createSideConversation(api, "Explain");
    expect(await conversation.initialize()).toBe(true);
    const sent = conversation.send();
    await started.promise;
    turn.reject(new Error("Provider unavailable"));
    await sent;
    expect(conversation.getSnapshot()).toMatchObject({
      draft: "Explain",
      status: "idle",
      error: "Provider unavailable",
    });
  });

  it("does not start nested side conversations", async () => {
    const { api } = setup();
    const conversation = createSideConversation(api);
    await conversation.initialize();
    conversation.setDraft("/side another question");
    await conversation.send();
    expect(api.send).not.toHaveBeenCalled();
    expect(conversation.getSnapshot().error).toContain("main thread");
  });

  it("ignores late stream output after a successful close", async () => {
    const { api, started, turn, emit } = setup();
    const conversation = createSideConversation(api, "Explain");
    await conversation.initialize();
    const sent = conversation.send();
    await started.promise;
    expect(await conversation.close(async () => true)).toBe(true);
    const closed = conversation.getSnapshot();
    emit({ type: "delta", text: "Late output" });
    turn.resolve();
    await sent;
    expect(conversation.getSnapshot()).toBe(closed);
  });
});

it("does not fork or consume a side draft containing attachments or context", async () => {
  const open = vi.fn(async () => true);
  const clearDraft = vi.fn();
  expect(
    await consumeSideCommandDraft({
      commandText: "/side question",
      prompt: "question",
      hasNonPromptContent: true,
      open,
      readDraft: () => "/side question",
      clearDraft,
    }),
  ).toBe("attachments");
  expect(open).not.toHaveBeenCalled();
  expect(clearDraft).not.toHaveBeenCalled();
});
