import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SideConversationOpenInput = Schema.Struct({ threadId: ThreadId });
export type SideConversationOpenInput = typeof SideConversationOpenInput.Type;

export const SideConversationTarget = Schema.Struct({
  conversationId: TrimmedNonEmptyString,
});
export type SideConversationTarget = typeof SideConversationTarget.Type;

export const SideConversationOpened = Schema.Struct({
  conversationId: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
});
export type SideConversationOpened = typeof SideConversationOpened.Type;

export const SideConversationSendInput = Schema.Struct({
  ...SideConversationTarget.fields,
  text: TrimmedNonEmptyString,
});
export type SideConversationSendInput = typeof SideConversationSendInput.Type;

export const SideConversationEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started"), turnId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("delta"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("completed"),
    status: Schema.Literals(["completed", "interrupted"]),
  }),
]);
export type SideConversationEvent = typeof SideConversationEvent.Type;

export class SideConversationError extends Schema.TaggedError<SideConversationError>()(
  "SideConversationError",
  {
    reason: Schema.Literals([
      "unsupported",
      "parent_unavailable",
      "not_found",
      "busy",
      "closed",
      "provider_failure",
      "request_unavailable",
      "close_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Side conversations are available for existing Codex threads.";
      case "parent_unavailable":
        return "Start a conversation in this Codex thread before opening a side conversation.";
      case "not_found":
      case "closed":
        return "This temporary side conversation has ended. Open a new one with /side.";
      case "busy":
        return "Wait for the side conversation to finish, or stop its current response.";
      case "close_failed":
        return "The side conversation could not be discarded. Try closing it again.";
      case "request_unavailable":
        return "This action needs an approval or interactive input. Continue it in the main conversation; side conversations do not support those requests yet.";
      case "provider_failure":
        return "Codex could not complete the side conversation. Check the provider and try again.";
    }
  }
}
