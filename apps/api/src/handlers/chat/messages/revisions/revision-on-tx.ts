import { panic } from "better-result";
import { deepEquals } from "bun";
import { and, eq, inArray } from "drizzle-orm";

import type { ChatMessageAcceptedEdit } from "@stll/api-contract/chat-message-revisions";
import { sha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import {
  chatMessages,
  chatMessageRevisions,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { isChatPart } from "@/api/handlers/chat/chat-message-parts";
import { hasChatWorkspaceAccess } from "@/api/handlers/chat/chat-scope";
import type { ChatWorkspaceAccess } from "@/api/handlers/chat/chat-scope";
import { ACTIVE_CHAT_TURN_STATUSES } from "@/api/handlers/chat/chat-turn-state";
import { normalizeRevisionContent } from "@/api/handlers/chat/messages/revisions/normalize-revision-content";
import { hasUnsettledRevisionContent } from "@/api/handlers/chat/messages/revisions/revision-settlement";
import { isRevisionEditSpanValid } from "@/api/handlers/chat/messages/revisions/revision-span";
import { findRevisionSpan } from "@/api/handlers/chat/messages/revisions/span-proposal";
import { reconcileChatCompactionChainOnTx } from "@/api/handlers/chat/persistent-compaction";
import type {
  PersistedChatMessageContent,
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { provePersistedChatMessageContentV3 } from "@/api/lib/chat/persisted-message-content";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import { enforceWritePrecondition } from "@/api/lib/write-contract";

export type ChatMessageRevisionChange =
  | {
      type: "accept";
      baseRevision: number;
      selectedTextHash: string;
      content: { version: 3; data: unknown[]; metadata?: unknown };
      edit: ChatMessageAcceptedEdit;
    }
  | { type: "revert"; baseRevision: number; toRevision: number };

const checkSelectedTextPrecondition = (
  content: PersistedChatMessageContentV3,
  change: Extract<ChatMessageRevisionChange, { type: "accept" }>,
) => {
  const anchor = findRevisionSpan({
    content,
    start: change.edit.start,
    end: change.edit.end,
  });
  if (anchor === null) {
    return new HandlerError({
      status: 409,
      code: VERSION_CONFLICT_ERROR_CODE,
      message: "Message revision changed; reload the message before editing",
    });
  }
  return enforceWritePrecondition({
    type: "revision",
    field: "selectedTextHash",
    storedRevision: sha256Hex(anchor.selected),
    expectedRevision: change.selectedTextHash,
    resource: "Chat message selection",
  });
};

type WriteChatMessageRevisionOptions = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  messageId: SafeId<"chatMessage">;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  change: ChatMessageRevisionChange;
  recordAuditEvent: AuditRecorder;
  getWorkspaceAccess: ChatWorkspaceAccess;
};

type ReadRevisionMessageOptions = Omit<
  WriteChatMessageRevisionOptions,
  "change" | "recordAuditEvent"
>;

// Turn acceptance and settlement lock the thread before touching messages.
// Keeping that order also prevents a turn from starting during an edit.
export const readRevisionMessageOnTx = async ({
  tx,
  threadId,
  messageId,
  userId,
  organizationId,
  getWorkspaceAccess,
}: ReadRevisionMessageOptions) => {
  const threadLock = await withAggregateRowQuery({
    tx,
    aggregate: "chatThread",
    id: { id: threadId, organizationId, userId },
    mode: "update",
    select: (handle) =>
      handle
        .select({
          id: chatThreads.id,
          organizationId: chatThreads.organizationId,
          userId: chatThreads.userId,
          workspaceId: chatThreads.workspaceId,
        })
        .from(chatThreads),
  });
  if (threadLock.status === "busy") {
    return panic("Blocking thread lock returned busy");
  }
  const thread = threadLock.rows.at(0);
  if (
    !thread ||
    !(await hasChatWorkspaceAccess({
      workspaceId: thread.workspaceId,
      getWorkspaceAccess,
    }))
  ) {
    return {
      type: "refused",
      status: 404,
      message: "Chat message not found",
    } as const;
  }
  const messageLock = await withAggregateRowQuery({
    tx,
    aggregate: "chatMessage",
    id: { id: messageId, threadId },
    mode: "update",
    select: (handle) => handle.select().from(chatMessages),
  });
  if (messageLock.status === "busy") {
    return panic("Blocking message lock returned busy");
  }
  const message = messageLock.rows.at(0);
  if (!message) {
    return {
      type: "refused",
      status: 404,
      message: "Chat message not found",
    } as const;
  }
  if (message.role !== "assistant") {
    return {
      type: "refused",
      status: 400,
      message: "Only assistant answers can be edited",
    } as const;
  }
  const active = (
    await tx
      .select({ id: chatTurns.id })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.threadId, threadId),
          inArray(chatTurns.status, ACTIVE_CHAT_TURN_STATUSES),
        ),
      )
      .limit(1)
  ).at(0);
  const { normalized, content: original } = normalizeRevisionContent(
    message.content,
  );
  if (active || hasUnsettledRevisionContent(normalized)) {
    return {
      type: "refused",
      status: 409,
      message: "Wait for the assistant turn to settle before editing",
    } as const;
  }
  return { type: "ready", message, original } as const;
};

const prepareAcceptedRevisionContent = (
  original: PersistedChatMessageContentV3,
  change: Extract<ChatMessageRevisionChange, { type: "accept" }>,
) => {
  const candidate = change.content;
  if (
    !deepEquals(candidate.metadata, original.metadata) ||
    candidate.data.length !== original.data.length
  ) {
    return {
      type: "refused",
      status: 400,
      message: "Answer edits must preserve metadata and non-text parts",
    } as const;
  }
  const data: PersistedChatMessageContentV3["data"] = [];
  for (const [index, part] of candidate.data.entries()) {
    const old = original.data.at(index);
    if (old?.type === "text") {
      if (!isChatPart(part) || part.type !== "text") {
        return {
          type: "refused",
          status: 400,
          message: "Answer edits must preserve metadata and non-text parts",
        } as const;
      }
      data.push(part);
      continue;
    }
    if (!old || !deepEquals(part, old)) {
      return {
        type: "refused",
        status: 400,
        message: "Answer edits must preserve metadata and non-text parts",
      } as const;
    }
    data.push(old);
  }
  if (
    !isRevisionEditSpanValid({
      originalParts: original.data,
      candidateParts: data,
      edit: change.edit,
    })
  ) {
    return {
      type: "refused",
      status: 400,
      message: "Edit range must refer to text in the current answer",
    } as const;
  }
  const content = provePersistedChatMessageContentV3(
    {
      version: 3,
      data,
      ...(original.metadata === undefined
        ? {}
        : { metadata: original.metadata }),
    },
    (part) =>
      isChatPart(part) || original.data.some((old) => deepEquals(part, old)),
  );
  return { type: "prepared", content } as const;
};

type PersistRevisionOptions = Pick<
  WriteChatMessageRevisionOptions,
  "tx" | "threadId" | "messageId" | "userId" | "recordAuditEvent"
> & {
  message: typeof chatMessages.$inferSelect;
  content: PersistedChatMessageContent;
  edit: ChatMessageAcceptedEdit | { type: "revert"; toRevision: number };
};

const persistRevisionOnTx = async ({
  tx,
  threadId,
  messageId,
  userId,
  recordAuditEvent,
  message,
  content,
  edit,
}: PersistRevisionOptions) => {
  const revision = message.revision + 1;
  await tx.insert(chatMessageRevisions).values({
    messageId,
    threadId,
    workspaceId: message.workspaceId,
    revision: message.revision,
    content: message.content,
    edit,
    createdBy: userId,
  });
  await tx
    .update(chatMessages)
    .set({ content, revision })
    .where(eq(chatMessages.id, messageId));
  await reconcileChatCompactionChainOnTx({
    deletedMessageIds: [],
    persistencePlan: {
      type: "update",
      messageId,
    },
    threadId,
    tx,
  });
  await tx
    .update(chatThreads)
    .set({
      updatedAt: new Date(),
      recapText: null,
      recapMessageId: null,
      recapPromptVersion: null,
      recapGeneratedAt: null,
    })
    .where(eq(chatThreads.id, threadId));
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
    resourceId: messageId,
    workspaceId: message.workspaceId,
    metadata: { editType: edit.type, revision },
  });
  return { type: "ok", revision, edited: true } as const;
};
type WriteLoadedRevisionOptions = Pick<
  WriteChatMessageRevisionOptions,
  "tx" | "threadId" | "messageId" | "userId" | "recordAuditEvent"
> & {
  loaded: Awaited<ReturnType<typeof readRevisionMessageOnTx>>;
};

type AcceptRevisionOptions = WriteLoadedRevisionOptions & {
  change: Extract<ChatMessageRevisionChange, { type: "accept" }>;
};

export const writeAcceptedChatMessageRevisionOnTx = async ({
  loaded,
  change,
  ...options
}: AcceptRevisionOptions) => {
  if (loaded.type === "refused") {
    return new HandlerError({ status: loaded.status, message: loaded.message });
  }
  const revisionConflict = enforceWritePrecondition({
    type: "revision",
    field: "baseRevision",
    storedRevision: loaded.message.revision,
    expectedRevision: change.baseRevision,
    resource: "Chat message",
  });
  if (revisionConflict) {
    return revisionConflict;
  }
  const prepared = prepareAcceptedRevisionContent(loaded.original, change);
  if (prepared.type === "refused") {
    return new HandlerError({
      status: prepared.status,
      message: prepared.message,
    });
  }
  const selectionConflict = checkSelectedTextPrecondition(
    loaded.original,
    change,
  );
  if (selectionConflict) {
    return selectionConflict;
  }
  return await persistRevisionOnTx({
    ...options,
    message: loaded.message,
    content: prepared.content,
    edit: change.edit,
  });
};

type RevertRevisionOptions = WriteLoadedRevisionOptions & {
  change: Extract<ChatMessageRevisionChange, { type: "revert" }>;
};

export const writeRevertedChatMessageRevisionOnTx = async ({
  loaded,
  change,
  ...options
}: RevertRevisionOptions) => {
  if (loaded.type === "refused") {
    return new HandlerError({ status: loaded.status, message: loaded.message });
  }
  const revisionConflict = enforceWritePrecondition({
    type: "revision",
    field: "baseRevision",
    storedRevision: loaded.message.revision,
    expectedRevision: change.baseRevision,
    resource: "Chat message",
  });
  if (revisionConflict) {
    return revisionConflict;
  }
  const target = (
    await options.tx
      .select({ content: chatMessageRevisions.content })
      .from(chatMessageRevisions)
      .where(
        and(
          eq(chatMessageRevisions.messageId, options.messageId),
          eq(chatMessageRevisions.threadId, options.threadId),
          eq(chatMessageRevisions.revision, change.toRevision),
        ),
      )
      .limit(1)
  ).at(0);
  if (!target) {
    return new HandlerError({
      status: 404,
      message: "Chat message revision not found",
    });
  }
  // Restore the retained JSONB without decoding or re-encoding it.
  return await persistRevisionOnTx({
    ...options,
    message: loaded.message,
    content: target.content,
    edit: { type: "revert", toRevision: change.toRevision },
  });
};

export const writeChatMessageRevisionOnTx = async ({
  change,
  ...options
}: WriteChatMessageRevisionOptions) => {
  const loaded = await readRevisionMessageOnTx(options);
  switch (change.type) {
    case "accept":
      return await writeAcceptedChatMessageRevisionOnTx({
        ...options,
        loaded,
        change,
      });
    case "revert":
      return await writeRevertedChatMessageRevisionOnTx({
        ...options,
        loaded,
        change,
      });
    default:
      return panic(change satisfies never);
  }
};
