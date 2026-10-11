import { panic } from "better-result";

import type {
  chatMessageRevisions,
  chatMessages,
  chatThreads,
} from "@/api/db/schema";
import { CHAT_TITLE_SOURCE } from "@/api/db/schema";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type { ChatMessageRole, ChatPart } from "@/api/handlers/chat/types";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

const PERSONAL_CHAT_ROLE_POLICY = {
  user: "export",
  assistant: "exclude",
  system: "exclude",
} as const satisfies Record<ChatMessageRole, "export" | "exclude">;

// Generated titles and matter references can contain data belonging to others.
export const toPersonalChatThreadResponse = (
  row: typeof chatThreads.$inferSelect,
) => ({
  id: row.id,
  title: row.titleSource === CHAT_TITLE_SOURCE.USER ? row.title : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const personalTextParts = (part: ChatPart) => {
  switch (part.type) {
    case "text":
      return [{ type: part.type, content: part.content }];
    case "audio":
    case "document":
    case "image":
    case "structured-output":
    case "subagent":
    case "thinking":
    case "tool-call":
    case "tool-result":
    case "ui-resource":
    case "video":
      return [];
    default:
      part satisfies never;
      return panic("Unhandled personal chat part");
  }
};

// Only authored text crosses this boundary; attachments, tool results and
// message metadata can reference documents or content owned by a matter.
export const toPersonalChatMessageResponse = (
  row: typeof chatMessages.$inferSelect,
) => {
  if (PERSONAL_CHAT_ROLE_POLICY[row.role] === "exclude") {
    return null;
  }
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    parts: normalizePersistedChatMessageContent(row.content).parts.flatMap(
      personalTextParts,
    ),
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  };
};

// Revisions inherit ownership and provenance from their message and thread.
export const toPersonalChatMessageRevisionResponse = (
  row: typeof chatMessageRevisions.$inferSelect,
  role: ChatMessageRole,
) => {
  if (PERSONAL_CHAT_ROLE_POLICY[role] === "exclude") {
    return null;
  }
  return {
    id: row.id,
    messageId: row.messageId,
    threadId: row.threadId,
    revision: row.revision,
    parts: normalizePersistedChatMessageContent(row.content).parts.flatMap(
      personalTextParts,
    ),
    createdAt: row.createdAt.toISOString(),
  };
};

type ChatThreadRow = typeof chatThreads.$inferSelect;
type PersonalChatThreadResponse = ReturnType<
  typeof toPersonalChatThreadResponse
>;

// Columns intentionally left out of the account export.
const UNEXPORTED_CHAT_THREAD_COLUMNS = [
  // Tenant id: internal routing, not data the user provided.
  "organizationId",
  // The exporting account itself; every exported thread is its own.
  "userId",
  // Matter and decision references point at organization data, not the
  // user's own (see the comment on toPersonalChatThreadResponse).
  "workspaceId",
  "contextMatterIds",
  "dataWorkspaceIds",
  "subjectDecisionId",
  // Consumed to decide whether `title` is user-authored; only then is the
  // title exported.
  "titleSource",
  // Per-thread runtime settings: how the assistant ran, not authored content.
  "webSearchEnabled",
  "chatModel",
  "chatReasoningEffort",
  // Internal processing flag recording that anonymization ran on a turn.
  "usedAnonymization",
  // Disconnect-compensation token for thread creation; internal machinery.
  "rollbackToken",
  // AI-generated recap cache derived from the whole transcript, including
  // assistant output, which the export excludes.
  "recapText",
  "recapMessageId",
  "recapPromptVersion",
  "recapGeneratedAt",
  // Fork provenance points at threads and messages that may be assistant
  // output or no longer exist; it is internal lineage, not content.
  "parentThreadId",
  "forkedFromMessageId",
  // Compaction queue state owned by the background compactor.
  "compactionScheduledAt",
  "compactionAttemptedAt",
  "compactionAttempts",
  "compactionEpoch",
] as const satisfies readonly (keyof ChatThreadRow)[];

// Totality guard, bidirectional: every schema column must be exported or
// explicitly excused above, and the export cannot carry a field that traces
// back to no real column.
type MissingExportedChatThreadColumn = UnprojectedColumns<
  ChatThreadRow,
  PersonalChatThreadResponse,
  (typeof UNEXPORTED_CHAT_THREAD_COLUMNS)[number]
>;
type UnexpectedExportedChatThreadColumn = UnbackedProjectionKeys<
  ChatThreadRow,
  PersonalChatThreadResponse,
  (typeof UNEXPORTED_CHAT_THREAD_COLUMNS)[number]
>;

true satisfies MissingExportedChatThreadColumn extends never ? true : never;
true satisfies UnexpectedExportedChatThreadColumn extends never ? true : never;

type PersonalChatMessageResponse = NonNullable<
  ReturnType<typeof toPersonalChatMessageResponse>
>;
// `parts` is the authored-text view of the `content` column.
type ChatMessageExportRow = typeof chatMessages.$inferSelect &
  Pick<PersonalChatMessageResponse, "parts">;

// Columns intentionally left out of the account export.
const UNEXPORTED_CHAT_MESSAGE_COLUMNS = [
  // Exported as `parts`, reduced to authored text: attachments, tool results
  // and metadata can reference matter-owned documents.
  "content",
  // Matter reference: organization data, not the user's own.
  "workspaceId",
  // The exporting account itself; only its own messages are exported.
  "userId",
  // Internal processing flag for background memory extraction.
  "memoryExtractionEligible",
] as const satisfies readonly (keyof ChatMessageExportRow)[];

type MissingExportedChatMessageColumn = UnprojectedColumns<
  ChatMessageExportRow,
  PersonalChatMessageResponse,
  (typeof UNEXPORTED_CHAT_MESSAGE_COLUMNS)[number]
>;
type UnexpectedExportedChatMessageColumn = UnbackedProjectionKeys<
  ChatMessageExportRow,
  PersonalChatMessageResponse,
  (typeof UNEXPORTED_CHAT_MESSAGE_COLUMNS)[number]
>;

true satisfies MissingExportedChatMessageColumn extends never ? true : never;
true satisfies UnexpectedExportedChatMessageColumn extends never ? true : never;

type PersonalChatMessageRevisionResponse = NonNullable<
  ReturnType<typeof toPersonalChatMessageRevisionResponse>
>;
// `parts` is the authored-text view of the `content` column.
type ChatMessageRevisionExportRow = typeof chatMessageRevisions.$inferSelect &
  Pick<PersonalChatMessageRevisionResponse, "parts">;

// Columns intentionally left out of the account export.
const UNEXPORTED_CHAT_MESSAGE_REVISION_COLUMNS = [
  // Exported as `parts`, reduced to authored text (as for messages).
  "content",
  // Matter reference: organization data, not the user's own.
  "workspaceId",
  // Edit descriptor (span, AI instruction, model, key source) for answer
  // edits: it describes how assistant output was rewritten, while the
  // authored text itself is exported as `parts`.
  "edit",
  // Actor id; revisions inherit ownership from their message and thread.
  "createdBy",
] as const satisfies readonly (keyof ChatMessageRevisionExportRow)[];

type MissingExportedChatMessageRevisionColumn = UnprojectedColumns<
  ChatMessageRevisionExportRow,
  PersonalChatMessageRevisionResponse,
  (typeof UNEXPORTED_CHAT_MESSAGE_REVISION_COLUMNS)[number]
>;
type UnexpectedExportedChatMessageRevisionColumn = UnbackedProjectionKeys<
  ChatMessageRevisionExportRow,
  PersonalChatMessageRevisionResponse,
  (typeof UNEXPORTED_CHAT_MESSAGE_REVISION_COLUMNS)[number]
>;

true satisfies MissingExportedChatMessageRevisionColumn extends never
  ? true
  : never;
true satisfies UnexpectedExportedChatMessageRevisionColumn extends never
  ? true
  : never;
