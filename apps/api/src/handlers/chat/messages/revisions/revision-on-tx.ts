import { panic } from "better-result";
import { deepEquals } from "bun";
import { and, eq, inArray } from "drizzle-orm";

import type { ChatMessageAcceptedEdit } from "@stll/api-contract/chat-message-revisions";

import type { Transaction } from "@/api/db/root";
import {
  chatMessages,
  chatMessageRevisions,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import {
  getAwaitingUserInteractions,
  isChatPart,
  normalizePersistedChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { ACTIVE_CHAT_TURN_STATUSES } from "@/api/handlers/chat/chat-turn-state";
import { isRevisionToolCallSettled } from "@/api/handlers/chat/messages/revisions/revision-settlement";
import { isRevisionEditSpanValid } from "@/api/handlers/chat/messages/revisions/revision-span";
import { reconcileChatCompactionChainOnTx } from "@/api/handlers/chat/persistent-compaction";
import type { PersistedChatMessageContentV3 } from "@/api/handlers/chat/types";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { provePersistedChatMessageContentV3 } from "@/api/lib/chat/persisted-message-content";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";

export type ChatMessageRevisionChange =
  | {
      type: "accept";
      baseRevision: number;
      content: { version: 3; data: unknown[]; metadata?: unknown };
      edit: ChatMessageAcceptedEdit;
    }
  | { type: "revert"; baseRevision: number; toRevision: number };

type WriteChatMessageRevisionOptions = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  messageId: SafeId<"chatMessage">;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  change: ChatMessageRevisionChange;
  recordAuditEvent: AuditRecorder;
};

// Turn acceptance and settlement lock the thread before touching messages.
// Keeping that order also prevents a turn from starting during an edit.
export const writeChatMessageRevisionOnTx = async ({
  tx,
  threadId,
  messageId,
  userId,
  organizationId,
  change,
  recordAuditEvent,
}: WriteChatMessageRevisionOptions) => {
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
        })
        .from(chatThreads),
  });
  if (threadLock.status === "busy") {
    return panic("Blocking thread lock returned busy");
  }
  if (threadLock.rows.length === 0) {
    return { type: "not-found" } as const;
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
    return { type: "not-found" } as const;
  }
  if (message.role !== "assistant") {
    return { type: "not-assistant" } as const;
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
  const normalized = normalizePersistedChatMessageContent(message.content);
  if (
    active ||
    getAwaitingUserInteractions({
      role: "assistant",
      parts: normalized.parts,
      metadata: normalized.metadata,
    }).length > 0 ||
    normalized.parts.some(
      (part) =>
        (part.type === "tool-call" && !isRevisionToolCallSettled(part)) ||
        (part.type === "tool-result" && part.state === "streaming"),
    )
  ) {
    return { type: "unsettled" } as const;
  }
  if (message.revision !== change.baseRevision) {
    return { type: "stale" } as const;
  }

  const edit =
    change.type === "accept"
      ? change.edit
      : { type: "revert" as const, toRevision: change.toRevision };
  let content: typeof message.content;
  if (change.type === "revert") {
    const target = (
      await tx
        .select({ content: chatMessageRevisions.content })
        .from(chatMessageRevisions)
        .where(
          and(
            eq(chatMessageRevisions.messageId, messageId),
            eq(chatMessageRevisions.threadId, threadId),
            eq(chatMessageRevisions.revision, change.toRevision),
          ),
        )
        .limit(1)
    ).at(0);
    if (!target) {
      return { type: "revision-not-found" } as const;
    }
    // Do not decode/re-encode a snapshot: a revert restores the stored JSONB.
    content = target.content;
  } else {
    const original = toPersistedChatMessageContentV3({
      data: normalized.parts,
      ...(message.content.version === 1 ||
      message.content.metadata === undefined
        ? {}
        : { metadata: message.content.metadata }),
    });
    const candidate = change.content;
    if (
      !deepEquals(candidate.metadata, original.metadata) ||
      candidate.data.length !== original.data.length
    ) {
      return { type: "invalid-content" } as const;
    }
    const data: PersistedChatMessageContentV3["data"] = [];
    for (const [index, part] of candidate.data.entries()) {
      const old = original.data.at(index);
      if (old?.type === "text") {
        if (!isChatPart(part) || part.type !== "text") {
          return { type: "invalid-content" } as const;
        }
        data.push(part);
        continue;
      }
      if (!old || !deepEquals(part, old)) {
        return { type: "invalid-content" } as const;
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
      return { type: "invalid-edit" } as const;
    }
    content = provePersistedChatMessageContentV3(
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
  }
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
