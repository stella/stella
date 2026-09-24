import { and, eq, inArray } from "drizzle-orm";

import { chatMessages, chatTurns } from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import { CHAT_TURN_STATUSES } from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnStatus } from "@/api/handlers/chat/chat-turn-state";
import type { ChatPart } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { TestDatabase } from "@/api/tests/security/test-utils";

type ToolCallState = Extract<ChatPart, { type: "tool-call" }>["state"];

/**
 * Tool-call states a client can still answer from a reloaded thread: an
 * approval prompt, or a client-executed call whose input is complete and
 * whose result the client posts back. Every other state is settled or carries
 * no usable input.
 */
const CLIENT_ANSWERABLE_STATE = {
  "approval-requested": true,
  "approval-responded": false,
  "awaiting-input": false,
  complete: false,
  error: false,
  "input-complete": true,
  "input-streaming": false,
} as const satisfies Record<ToolCallState, boolean>;

export type UnownedPendingInteraction = {
  messageId: SafeId<"chatMessage">;
  state: ToolCallState;
  toolCallId: string;
};

/**
 * Persisted-thread invariant: every tool call a client can still answer sits
 * on an assistant message owned by an `awaiting-user` chat turn. A pending
 * part without that owner renders as actionable while no turn can accept its
 * answer as a resumption. Returns the violations; a sound thread returns [].
 */
export const findUnownedPendingInteractions = async ({
  db,
  threadId,
}: {
  db: TestDatabase;
  threadId: SafeId<"chatThread">;
}): Promise<UnownedPendingInteraction[]> => {
  const [rows, awaitingTurns] = await Promise.all([
    db
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId)),
    db
      .select({ assistantMessageId: chatTurns.assistantMessageId })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.threadId, threadId),
          eq(chatTurns.status, "awaiting-user"),
        ),
      ),
  ]);
  const ownedMessageIds = new Set(
    awaitingTurns.map(({ assistantMessageId }) => assistantMessageId),
  );
  const violations: UnownedPendingInteraction[] = [];
  for (const row of rows) {
    if (ownedMessageIds.has(row.id)) {
      continue;
    }
    for (const part of chatMessageFromPersisted(row).parts) {
      if (part.type === "tool-call" && CLIENT_ANSWERABLE_STATE[part.state]) {
        violations.push({
          messageId: row.id,
          state: part.state,
          toolCallId: part.id,
        });
      }
    }
  }
  return violations;
};

/**
 * Turn statuses that still own their assistant message: the turn may yet write
 * a tool result there. Every other status has settled.
 */
const LIVE_TURN_STATUS = {
  accepted: true,
  "awaiting-user": true,
  cancelled: false,
  completed: false,
  failed: false,
  interrupted: false,
  running: true,
} as const satisfies Record<ChatTurnStatus, boolean>;

const LIVE_TURN_STATUSES = CHAT_TURN_STATUSES.filter(
  (status) => LIVE_TURN_STATUS[status],
);

/** Tool-call states that are a final disposition of the call. */
const SETTLED_TOOL_CALL_STATE = {
  "approval-requested": false,
  "approval-responded": false,
  "awaiting-input": false,
  complete: true,
  error: true,
  "input-complete": false,
  "input-streaming": false,
} as const satisfies Record<ToolCallState, boolean>;

export type UnsettledToolCall = {
  messageId: SafeId<"chatMessage">;
  state: ToolCallState;
  toolCallId: string;
};

/**
 * Persisted-thread invariant: a tool call outside every live turn has a final
 * disposition: its result or error is stored, or its approval was denied. An
 * approved call whose output never reached the database renders as running
 * forever after a reload, and the next turn resumes it as still pending.
 * Returns the violations; a sound thread returns [].
 */
export const findUnsettledToolCalls = async ({
  db,
  threadId,
}: {
  db: TestDatabase;
  threadId: SafeId<"chatThread">;
}): Promise<UnsettledToolCall[]> => {
  const [rows, liveTurns] = await Promise.all([
    db
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId)),
    db
      .select({ assistantMessageId: chatTurns.assistantMessageId })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.threadId, threadId),
          inArray(chatTurns.status, LIVE_TURN_STATUSES),
        ),
      ),
  ]);
  const liveMessageIds = new Set(
    liveTurns.map(({ assistantMessageId }) => assistantMessageId),
  );
  const violations: UnsettledToolCall[] = [];
  for (const row of rows) {
    if (liveMessageIds.has(row.id)) {
      continue;
    }
    for (const part of chatMessageFromPersisted(row).parts) {
      if (
        part.type === "tool-call" &&
        !SETTLED_TOOL_CALL_STATE[part.state] &&
        !("approval" in part && part.approval.approved === false)
      ) {
        violations.push({
          messageId: row.id,
          state: part.state,
          toolCallId: part.id,
        });
      }
    }
  }
  return violations;
};
