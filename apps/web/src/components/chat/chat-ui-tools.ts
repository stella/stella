/**
 * UI tool type definitions for the chat. Maps backend tool
 * names to their input/output shapes so message parts are
 * properly typed when matched via `part.type === "tool-X"`.
 *
 * Only tools that have custom frontend rendering need entries
 * here. Generic tools (searchMatter, listEntities, etc.) fall
 * through to the untyped ToolCallCard.
 */

import { isToolUIPart } from "ai";
import type { ToolUIPart, UIDataTypes, UIMessage } from "ai";

// ── askUser ────────────────────────────────────────────

type AskUserQuestion = {
  question: string;
  reason: string;
  options?: string[];
  default?: string;
};

export type AskUserInput = {
  analysis: string;
  questions: AskUserQuestion[];
};

type AskUserOutput = {
  status: "awaiting_response";
  analysis: string;
  questionCount: number;
};

// ── displayDocument ────────────────────────────────────

type DisplayDocumentInput = {
  view: "simple" | "original" | "tracked-changes";
  filename: string;
};

export type DisplayDocumentOutput = {
  filename: string;
  view: string;
  text: string;
};

// ── updateEntityFields (approval tool) ─────────────────

type UpdateEntityFieldsInput = {
  workspaceId: string;
  entityId: string;
  propertyId: string;
  value: string | number | string[] | null;
  entityName?: string;
  propertyName?: string;
  oldValue?: string;
};

type UpdateEntityFieldsOutput =
  | { success: true; entityId: string; propertyId: string; newValue: string }
  | { error: string };

// ── createDocument (approval tool) ─────────────────────

type CreateDocumentInput = {
  workspaceId: string;
  name: string;
  markdown: string;
};

type CreateDocumentOutput =
  | { success: true; entityId: string; fileName: string }
  | { error: string };

// ── Combined UI tools map ──────────────────────────────

/**
 * Maps tool names to `{ input, output }` for typed
 * `ToolUIPart` matching. Use with `UIMessage<unknown,
 * never, ChatUITools>` to get discriminated tool parts.
 */
export type ChatUITools = {
  askUser: {
    input: AskUserInput;
    output: AskUserOutput;
  };
  displayDocument: {
    input: DisplayDocumentInput;
    output: DisplayDocumentOutput;
  };
  updateEntityFields: {
    input: UpdateEntityFieldsInput;
    output: UpdateEntityFieldsOutput;
  };
  createDocument: {
    input: CreateDocumentInput;
    output: CreateDocumentOutput;
  };
};

/**
 * UIMessage narrowed to our known tool definitions.
 * Use this as the message type for Chat and useChat
 * so that `part.type === "tool-askUser"` narrows typed
 * input/output automatically.
 */
export type ChatMessage = UIMessage<unknown, UIDataTypes, ChatUITools>;

type ChatMessagePart = ChatMessage["parts"][number];

/** Check if a tool part has an approval field (approval flow). */
export const isApprovalPart = (
  part: ChatMessagePart,
): part is ToolUIPart<ChatUITools> & {
  approval: { id: string };
} =>
  isToolUIPart(part) &&
  "approval" in part &&
  typeof part.approval === "object" &&
  part.approval !== null &&
  "id" in part.approval &&
  typeof part.approval.id === "string";
