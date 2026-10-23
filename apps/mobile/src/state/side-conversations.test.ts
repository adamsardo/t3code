import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  open: vi.fn(),
  send: vi.fn(),
  interrupt: vi.fn(),
  close: vi.fn(),
  id: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/side-conversations", () => ({
  createSideConversationEnvironmentAtoms: () => ({
    open: { run: commands.open },
    send: { run: commands.send },
    interrupt: { run: commands.interrupt },
    close: { run: commands.close },
  }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./threads", () => ({ environmentThreadDetails: {} }));
vi.mock("../lib/uuid", () => ({ uuidv4: commands.id }));

import { appAtomRegistry } from "./atom-registry";
import {
  activateSideConversation,
  openSideConversation,
  setSideConversationsVisible,
  sideConversationTabsAtom,
} from "./side-conversations";
const getState = () => appAtomRegistry.get(sideConversationTabsAtom);

const parent = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("main-thread"),
};
const input = { parent, parentTitle: "Main task", cwd: "/workspace", prompt: "" };

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function setup() {
  vi.resetAllMocks();
  commands.id.mockReturnValueOnce("tab-1").mockReturnValueOnce("tab-2");
  commands.open.mockResolvedValue({ _tag: "Success", value: { conversationId: "side-1" } });
  commands.send.mockResolvedValue({ _tag: "Success", value: undefined });
  commands.interrupt.mockResolvedValue({ _tag: "Success", value: undefined });
  commands.close.mockResolvedValue({ _tag: "Success", value: undefined });
  appAtomRegistry.set(sideConversationTabsAtom, { tabs: [], activeId: null, visible: false });
}

it("keeps independent side tabs and their originating parent through activation", async () => {
  setup();
  await openSideConversation(input);
  const first = getState().tabs[0]!;
  first.conversation.setDraft("A side question");
  await openSideConversation({
    ...input,
    parent: { ...parent, threadId: ThreadId.make("another-main-thread") },
    parentTitle: "Another task",
  });
  expect(getState().activeId).toBe("tab-2");
  activateSideConversation("tab-1");
  expect(first.conversation.getSnapshot().draft).toBe("A side question");
  expect(getState().tabs.map((tab) => tab.parent.threadId)).toEqual([
    "main-thread",
    "another-main-thread",
  ]);
});

it("rejects a failed fork and removes only its loading tab", async () => {
  setup();
  await openSideConversation(input);
  commands.open.mockRejectedValueOnce(new Error("Could not fork"));
  await expect(openSideConversation(input)).rejects.toThrow("Could not fork");
  expect(getState().tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
  expect(getState().activeId).toBe("tab-1");
});

it("does not remove a loading tab before a racing close finishes cleanup", async () => {
  setup();
  const fork = deferred<{ _tag: "Success"; value: { conversationId: string } }>();
  commands.open.mockImplementationOnce(() => fork.promise);
  commands.close.mockRejectedValueOnce(new Error("Could not close"));
  const opened = openSideConversation(input);
  const tab = getState().tabs[0]!;
  const closed = tab.conversation.close(async () => true);
  fork.resolve({ _tag: "Success", value: { conversationId: "late-child" } });
  await opened;
  expect(await closed).toBe(false);
  expect(getState().tabs[0]).toBe(tab);
  expect(tab.conversation.getSnapshot().error).toBe("Could not close");
});

it("hides and reopens without discarding side drafts", async () => {
  setup();
  await openSideConversation(input);
  const conversation = getState().tabs[0]!.conversation;
  conversation.setDraft("Keep this question");
  setSideConversationsVisible(false);
  expect(getState().visible).toBe(false);
  setSideConversationsVisible(true);
  expect(getState().visible).toBe(true);
  expect(conversation.getSnapshot().draft).toBe("Keep this question");
  expect(commands.close).not.toHaveBeenCalled();
});
