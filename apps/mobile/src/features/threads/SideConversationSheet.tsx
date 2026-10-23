import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  TextInput,
  View,
  type ScrollViewInstance,
  type TextInputInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  activateSideConversation,
  removeSideConversation,
  setSideConversationsVisible,
  sideConversationEnvironment,
  sideConversationTabsAtom,
  type SideConversationTab,
} from "../../state/side-conversations";

export function SideConversationSheet() {
  const { tabs, activeId, visible } = useAtomValue(sideConversationTabsAtom);
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const active = tabs.find((tab) => tab.id === activeId);
  if (!focused || !active) return null;
  if (!visible) {
    return (
      <View className="absolute right-4" style={{ top: insets.top + 52 }}>
        <Button
          label={`Side chats (${tabs.length})`}
          onPress={() => setSideConversationsVisible(true)}
        />
      </View>
    );
  }
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={() => setSideConversationsVisible(false)}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-screen"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="px-4 py-2">
          <Button
            label="Back to main thread"
            tone="text"
            onPress={() => setSideConversationsVisible(false)}
          />
        </View>
        <View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}
          >
            {tabs.map((tab) => (
              <Button
                key={tab.id}
                label={tab.title}
                accessibilityLabel={`${tab.title}${tab.id === activeId ? ", selected" : ""}`}
                tone={tab.id === activeId ? "primary" : "secondary"}
                onPress={() => activateSideConversation(tab.id)}
              />
            ))}
          </ScrollView>
        </View>
        <SideConversationContent key={active.id} tab={active} />
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SideConversationContent({ tab }: { readonly tab: SideConversationTab }) {
  const state = useSyncExternalStore(tab.conversation.subscribe, tab.conversation.getSnapshot);
  const canSend = useAtomValue(
    sideConversationEnvironment.send.permissionAtom(tab.parent.environmentId),
  );
  const canInterrupt = useAtomValue(
    sideConversationEnvironment.interrupt.permissionAtom(tab.parent.environmentId),
  );
  const canClose = useAtomValue(
    sideConversationEnvironment.close.permissionAtom(tab.parent.environmentId),
  );
  const scrollRef = useRef<ScrollViewInstance>(null);
  const followsEnd = useRef(true);
  const inputRef = useRef<TextInputInstance>(null);
  const focusedComposer = useRef(false);
  useEffect(() => {
    if (
      !canSend ||
      state.status === "opening" ||
      state.status === "closing" ||
      focusedComposer.current
    )
      return;
    inputRef.current?.focus();
    focusedComposer.current = true;
  }, [canSend, state.status]);
  const markdown = useMarkdownPreviewStyles();
  const running = state.status === "sending" || state.status === "interrupting";
  const busy = state.status !== "idle";
  const close = async () => {
    const closed = await tab.conversation.close(
      () =>
        new Promise<boolean>((resolve) => {
          Dialog.confirm({
            title: "Close this side conversation?",
            message: "Its messages and draft will be discarded.",
            confirmText: "Close side chat",
            destructive: true,
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          });
        }),
    );
    if (closed) removeSideConversation(tab.id);
  };
  return (
    <View className="flex-1">
      <View className="flex-row items-center justify-between gap-2 border-b border-border px-4 pb-3">
        <View className="min-w-0 flex-1 gap-1">
          <AppText accessibilityRole="header" className="text-lg font-t3-semibold">
            {tab.title}
          </AppText>
          <AppText className="text-sm text-foreground-secondary" numberOfLines={2}>
            From: {tab.parentTitle || "Untitled thread"}
          </AppText>
        </View>
        <Button
          label="Close"
          accessibilityLabel="Close side conversation"
          tone="text"
          disabled={!canClose || state.status === "closing"}
          onPress={() => void close()}
        />
      </View>
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, gap: 24 }}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          followsEnd.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (followsEnd.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
        {state.messages.length === 0 ? (
          <View className="gap-3">
            <AppText className="text-xl font-t3-semibold">A quick conversation on the side</AppText>
            <AppText className="text-base text-foreground-secondary">
              This side conversation starts with the main thread’s context. Its messages stay
              separate and disappear when you close it, reload, or exit the app.
            </AppText>
          </View>
        ) : (
          state.messages.map((message) => (
            <View key={message.id} className="gap-2">
              <AppText className="text-sm font-t3-medium text-foreground-secondary">
                {message.role === "user" ? "You" : "Codex"}
              </AppText>
              {message.role === "assistant" ? (
                <SelectableMarkdownText
                  markdown={message.text}
                  textStyle={markdown.nativeTextStyle}
                />
              ) : (
                <AppText selectable className="text-base">
                  {message.text}
                </AppText>
              )}
            </View>
          ))
        )}
        {state.status === "opening" ? (
          <AppText className="text-sm text-foreground-muted">Opening side conversation…</AppText>
        ) : null}
        {running ? (
          <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {state.status === "interrupting" ? "Stopping…" : "Codex is working…"}
          </AppText>
        ) : null}
        {state.interrupted ? (
          <AppText className="text-sm text-foreground-muted">Response stopped.</AppText>
        ) : null}
        {state.error ? (
          <AppText accessibilityRole="alert" className="text-sm text-danger">
            {state.error}
          </AppText>
        ) : null}
      </ScrollView>
      <View className="gap-3 border-t border-border p-4">
        <TextInput
          ref={inputRef}
          accessibilityLabel="Side conversation message"
          placeholder="Ask on the side…"
          placeholderTextColorClassName="accent-foreground-muted"
          className="min-h-16 max-h-40 rounded-2xl bg-subtle p-4 text-base text-foreground"
          multiline
          value={state.draft}
          onChangeText={tab.conversation.setDraft}
          editable={
            canSend && !state.closed && state.status !== "opening" && state.status !== "closing"
          }
          textAlignVertical="top"
        />
        <View className="flex-row justify-end">
          {running ? (
            <Button
              label="Stop"
              disabled={!canInterrupt || state.status === "interrupting"}
              onPress={() => void tab.conversation.interrupt()}
            />
          ) : (
            <Button
              label="Send"
              tone="primary"
              disabled={!canSend || busy || !state.draft.trim()}
              onPress={() => void tab.conversation.send()}
            />
          )}
        </View>
      </View>
    </View>
  );
}
