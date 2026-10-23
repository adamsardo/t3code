import { useAtomValue } from "@effect/atom-react";
import { ArrowLeftIcon, ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { ensureLocalApi } from "../../localApi";
import {
  sideConversationEnvironment,
  useSideConversationTabs,
  type SideConversationTab,
} from "../../state/sideConversations";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { cn } from "../../lib/utils";

export function SideConversationPanel() {
  const tabs = useSideConversationTabs((state) => state.tabs);
  const activeId = useSideConversationTabs((state) => state.activeId);
  const activate = useSideConversationTabs((state) => state.activate);
  const visible = useSideConversationTabs((state) => state.visible);
  const hide = useSideConversationTabs((state) => state.hide);
  const show = useSideConversationTabs((state) => state.show);
  const active = tabs.find((tab) => tab.id === activeId);
  if (!active) return null;
  if (!visible) {
    return (
      <div className="absolute top-14 right-4 z-20">
        <Button variant="outline" size="sm" onClick={show}>
          Side chats ({tabs.length})
        </Button>
      </div>
    );
  }

  return (
    <aside
      aria-label="Side conversations"
      data-side-conversation
      className="flex min-h-0 w-[min(440px,45vw)] min-w-80 shrink-0 flex-col border-l bg-background max-md:absolute max-md:inset-x-0 max-md:top-(--workspace-topbar-height) max-md:bottom-0 max-md:z-20 max-md:w-full max-md:min-w-0"
    >
      <div className="flex shrink-0 items-center border-b px-2 py-1">
        <Button variant="ghost" size="sm" onClick={hide}>
          <ArrowLeftIcon /> Back to main thread
        </Button>
      </div>
      <div
        role="tablist"
        aria-label="Side conversations"
        className="flex shrink-0 overflow-x-auto border-b px-2"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`side-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-controls={`side-panel-${tab.id}`}
            aria-selected={tab.id === activeId}
            tabIndex={tab.id === activeId ? 0 : -1}
            className={cn(
              "shrink-0 border-b-2 px-3 py-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              tab.id === activeId
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => activate(tab.id)}
            onKeyDown={(event) => {
              const index = tabs.findIndex((entry) => entry.id === tab.id);
              const next =
                event.key === "ArrowRight"
                  ? tabs[(index + 1) % tabs.length]
                  : event.key === "ArrowLeft"
                    ? tabs[(index - 1 + tabs.length) % tabs.length]
                    : null;
              if (!next) return;
              event.preventDefault();
              activate(next.id);
              document.getElementById(`side-tab-${next.id}`)?.focus();
            }}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <SideConversationContent key={active.id} tab={active} />
    </aside>
  );
}

function SideConversationContent({ tab }: { readonly tab: SideConversationTab }) {
  const state = useSyncExternalStore(tab.conversation.subscribe, tab.conversation.getSnapshot);
  const remove = useSideConversationTabs((current) => current.remove);
  const canSend = useAtomValue(
    sideConversationEnvironment.send.permissionAtom(tab.parent.environmentId),
  );
  const canInterrupt = useAtomValue(
    sideConversationEnvironment.interrupt.permissionAtom(tab.parent.environmentId),
  );
  const canClose = useAtomValue(
    sideConversationEnvironment.close.permissionAtom(tab.parent.environmentId),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const followsEnd = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const focusedComposer = useRef(false);
  const running = state.status === "sending" || state.status === "interrupting";
  const busy = state.status !== "idle";
  const latestText = state.messages.at(-1)?.text;

  useEffect(() => {
    if (latestText !== undefined && followsEnd.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [latestText]);
  useEffect(() => {
    if (state.status === "opening" || state.status === "closing" || focusedComposer.current) return;
    composerRef.current?.focus();
    focusedComposer.current = true;
  }, [state.status]);

  const close = async () => {
    const closed = await tab.conversation.close(() =>
      ensureLocalApi().dialogs.confirm(
        "Close this side conversation? Its messages and draft will be discarded.",
        { variant: "destructive" },
      ),
    );
    if (closed) remove(tab.id);
  };

  return (
    <section
      role="tabpanel"
      id={`side-panel-${tab.id}`}
      aria-labelledby={`side-tab-${tab.id}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{tab.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
            Context from {tab.parentTitle}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Close ${tab.title.toLowerCase()}`}
          disabled={!canClose || state.status === "closing"}
          onClick={() => void close()}
        >
          <XIcon />
        </Button>
      </header>
      <div
        ref={scrollRef}
        role="log"
        aria-label="Side conversation messages"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
        onScroll={(event) => {
          const node = event.currentTarget;
          followsEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        {state.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ask a side question using this thread’s context. This conversation stays separate from
            the main thread and disappears when you close it, reload, or exit the app.
          </p>
        ) : null}
        <div className="flex flex-col gap-5">
          {state.messages.map((message) =>
            message.text ? (
              <article key={message.id} aria-label={message.role === "user" ? "You" : "Codex"}>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {message.role === "user" ? "You" : "Codex"}
                </div>
                {message.role === "assistant" ? (
                  <ChatMarkdown
                    text={message.text}
                    cwd={tab.cwd}
                    environmentId={tab.parent.environmentId}
                    isStreaming={running && message.id === state.messages.at(-1)?.id}
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm wrap-anywhere">{message.text}</p>
                )}
              </article>
            ) : null,
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t p-3">
        {state.error ? (
          <p role="alert" className="text-xs text-destructive">
            {state.error}
          </p>
        ) : null}
        <p role="status" className="text-xs text-muted-foreground">
          {state.status === "opening"
            ? "Opening side conversation…"
            : state.status === "closing"
              ? "Closing side conversation…"
              : state.status === "interrupting"
                ? "Stopping…"
                : running
                  ? "Codex is responding…"
                  : state.interrupted
                    ? "Response stopped"
                    : "Temporary conversation"}
        </p>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            followsEnd.current = true;
            void tab.conversation.send();
          }}
        >
          <Textarea
            ref={composerRef}
            aria-label="Side question"
            placeholder="Ask a side question…"
            value={state.draft}
            disabled={!canSend || state.status === "opening" || state.status === "closing"}
            onChange={(event) => tab.conversation.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!busy && canSend) {
                  followsEnd.current = true;
                  void tab.conversation.send();
                }
              }
            }}
          />
          <div className="flex justify-end">
            {running ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canInterrupt || state.status === "interrupting"}
                onClick={() => void tab.conversation.interrupt()}
              >
                <SquareIcon /> Stop
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={busy || !canSend || !state.draft.trim()}>
                <ArrowUpIcon /> Send
              </Button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
