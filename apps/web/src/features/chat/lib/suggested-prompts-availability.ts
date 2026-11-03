import { panic } from "better-result";

import type {
  ChatMessage,
  ChatPart,
  UserInputChatToolName,
} from "@/components/chat/chat-ui-tools";
import {
  isUserInputChatToolName,
  resolveChatAssistantTurnOutcome,
} from "@/components/chat/chat-ui-tools";

type SuggestedPromptsAvailability =
  | { status: "eligible"; lastMessageId: string }
  | {
      status: "blocked";
      reason:
        | "draft"
        | "error"
        | "generating"
        | "no-assistant-turn"
        | "terminal-outcome"
        | "turn-owned";
    };

type ResolveSuggestedPromptsAvailabilityOptions = {
  editorIsEmpty: boolean;
  error: Error | undefined;
  isGenerating: boolean;
  lastMessage:
    | (Pick<ChatMessage, "id" | "metadata" | "role"> & {
        parts: readonly ChatPart[];
      })
    | null;
  turnAbandoned: boolean;
  turnOwner: SuggestedPromptsTurnOwner;
};

export type SuggestedPromptsTurnOwner =
  "approval" | "ask-user" | "secret" | "connector" | "composer";

type ToolCallState = Extract<ChatPart, { type: "tool-call" }>["state"];
const ASK_USER_STATE_OWNS_TURN = {
  "awaiting-input": true,
  "approval-requested": true,
  "approval-responded": false,
  complete: false,
  error: false,
  "input-complete": true,
  "input-streaming": true,
} as const satisfies Record<ToolCallState, boolean>;

type UserInputTurnOwner = Extract<
  SuggestedPromptsTurnOwner,
  "ask-user" | "secret" | "connector"
>;
const USER_INPUT_TURN_OWNERS = {
  "ask-user": "ask-user",
  connect_connector: "connector",
  request_secret: "secret",
} as const satisfies Record<UserInputChatToolName, UserInputTurnOwner>;

type ResolveSuggestedPromptsTurnOwnerOptions = {
  approvalPendingMessageId: string | null;
  hasReopenedAskUser: boolean;
  lastMessage: ChatMessage | null;
};

export const resolveSuggestedPromptsTurnOwner = ({
  approvalPendingMessageId,
  hasReopenedAskUser,
  lastMessage,
}: ResolveSuggestedPromptsTurnOwnerOptions): SuggestedPromptsTurnOwner => {
  if (approvalPendingMessageId !== null) {
    return "approval";
  }
  if (hasReopenedAskUser) {
    return "ask-user";
  }
  if (lastMessage?.role !== "assistant") {
    return "composer";
  }
  const owners = new Set(
    lastMessage.parts.flatMap((part) => {
      if (
        part.type !== "tool-call" ||
        !ASK_USER_STATE_OWNS_TURN[part.state] ||
        !isUserInputChatToolName(part.name)
      ) {
        return [];
      }
      return [USER_INPUT_TURN_OWNERS[part.name]];
    }),
  );
  // A private input card outranks a connector card, which outranks a question.
  if (owners.has("secret")) {
    return "secret";
  }
  if (owners.has("connector")) {
    return "connector";
  }
  return owners.has("ask-user") ? "ask-user" : "composer";
};

export const resolveSuggestedPromptsAvailability = ({
  editorIsEmpty,
  error,
  isGenerating,
  lastMessage,
  turnAbandoned,
  turnOwner,
}: ResolveSuggestedPromptsAvailabilityOptions): SuggestedPromptsAvailability => {
  if (error !== undefined) {
    return { status: "blocked", reason: "error" };
  }
  if (isGenerating) {
    return { status: "blocked", reason: "generating" };
  }
  if (turnAbandoned) {
    return { status: "blocked", reason: "terminal-outcome" };
  }
  if (!editorIsEmpty) {
    return { status: "blocked", reason: "draft" };
  }
  if (turnOwner !== "composer") {
    return { status: "blocked", reason: "turn-owned" };
  }
  if (lastMessage?.role !== "assistant") {
    return { status: "blocked", reason: "no-assistant-turn" };
  }
  const turnOutcome = resolveChatAssistantTurnOutcome(lastMessage);
  switch (turnOutcome.type) {
    case "completed":
    case "legacy-completed":
      return { status: "eligible", lastMessageId: lastMessage.id };
    case "awaiting-user":
    case "cancelled":
    case "failed":
    case "incomplete":
    case "interrupted":
      return { status: "blocked", reason: "terminal-outcome" };
    default:
      turnOutcome satisfies never;
      return panic(`Unhandled turn outcome: ${String(turnOutcome)}`);
  }
};
