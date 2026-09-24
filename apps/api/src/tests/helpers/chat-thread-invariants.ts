import { and, eq, inArray } from "drizzle-orm";

import { chatMessages, chatTurns } from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import {
  CLIENT_ANSWERABLE_TOOL_CALL_STATE,
  isSettledToolCall,
} from "@/api/handlers/chat/chat-turn-settlement";
import type { ToolCallState } from "@/api/handlers/chat/chat-turn-settlement";
import { CHAT_TURN_STATUSES } from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnStatus } from "@/api/handlers/chat/chat-turn-state";
import type { SafeId } from "@/api/lib/branded-types";
import type { TestDatabase } from "@/api/tests/security/test-utils";

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

export type ToolCallViolation = {
  messageId: SafeId<"chatMessage">;
  state: ToolCallState;
  toolCallId: string;
};

const readThread = async ({
  db,
  ownerStatuses,
  threadId,
}: {
  db: TestDatabase;
  ownerStatuses: readonly ChatTurnStatus[];
  threadId: SafeId<"chatThread">;
}) => {
  const [rows, owners] = await Promise.all([
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
          inArray(chatTurns.status, [...ownerStatuses]),
        ),
      ),
  ]);
  const ownedMessageIds = new Set(
    owners.map(({ assistantMessageId }) => assistantMessageId),
  );
  return rows
    .filter(({ id }) => !ownedMessageIds.has(id))
    .map((row) => ({ id: row.id, parts: chatMessageFromPersisted(row).parts }));
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
}): Promise<ToolCallViolation[]> =>
  (
    await readThread({ db, ownerStatuses: ["awaiting-user"], threadId })
  ).flatMap(({ id, parts }) =>
    parts.flatMap((part) =>
      part.type === "tool-call" && CLIENT_ANSWERABLE_TOOL_CALL_STATE[part.state]
        ? [{ messageId: id, state: part.state, toolCallId: part.id }]
        : [],
    ),
  );

/**
 * Persisted-thread invariant: a tool call outside every live turn has a final
 * disposition: its result or error is stored, or its approval was denied. A
 * call without one reloads as still running and joins the next turn's pending
 * batch. Returns the violations; a sound thread returns [].
 */
export const findUnsettledToolCalls = async ({
  db,
  threadId,
}: {
  db: TestDatabase;
  threadId: SafeId<"chatThread">;
}): Promise<ToolCallViolation[]> =>
  (
    await readThread({ db, ownerStatuses: LIVE_TURN_STATUSES, threadId })
  ).flatMap(({ id, parts }) =>
    parts.flatMap((part) =>
      part.type === "tool-call" && !isSettledToolCall(part)
        ? [{ messageId: id, state: part.state, toolCallId: part.id }]
        : [],
    ),
  );

/** Every persisted-thread invariant, keyed by name; all empty for a sound
 *  thread. */
export const findThreadInvariantViolations = async ({
  db,
  threadId,
}: {
  db: TestDatabase;
  threadId: SafeId<"chatThread">;
}) => {
  const [unownedPendingInteractions, unsettledToolCalls] = await Promise.all([
    findUnownedPendingInteractions({ db, threadId }),
    findUnsettledToolCalls({ db, threadId }),
  ]);
  return { unownedPendingInteractions, unsettledToolCalls };
};
