import { and, asc, eq, inArray } from "drizzle-orm";

import { chatMessages, chatTurns } from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import {
  CLIENT_ANSWERABLE_TOOL_CALL_STATE,
  findUnsettledToolCallsForOutcome,
} from "@/api/handlers/chat/chat-turn-settlement";
import type { ToolCallState } from "@/api/handlers/chat/chat-turn-settlement";
import type { ChatTurnStatus } from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnOutcome } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Turn statuses still writing their assistant message. `awaiting-user` has
 * settled for now: its message is what reloads until the user answers.
 */
const LIVE_TURN_STATUS = {
  accepted: true,
  "awaiting-user": false,
  cancelled: false,
  completed: false,
  failed: false,
  interrupted: false,
  running: true,
} as const satisfies Record<ChatTurnStatus, boolean>;

/** The outcome each settled status records. */
const SETTLED_TURN_OUTCOME = {
  accepted: "completed",
  "awaiting-user": "awaiting-user",
  cancelled: "cancelled",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
  running: "completed",
} as const satisfies Record<ChatTurnStatus, ChatTurnOutcome["type"]>;

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
 * Persisted-thread invariant: each assistant message outside a live turn keeps
 * only the open tool calls the way its turn ended allows, by the same rule
 * production reports when a turn settles. A message no turn owns is held to
 * the completed-turn rule. Returns the violations; a sound thread returns [].
 */
const findUnsettledToolCalls = async ({
  db,
  threadId,
}: {
  db: TestDatabase;
  threadId: SafeId<"chatThread">;
}): Promise<ToolCallViolation[]> => {
  const [rows, turns] = await Promise.all([
    db
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId)),
    db
      .select({
        assistantMessageId: chatTurns.assistantMessageId,
        status: chatTurns.status,
      })
      .from(chatTurns)
      .where(eq(chatTurns.threadId, threadId))
      .orderBy(asc(chatTurns.createdAt)),
  ]);
  // The latest turn that wrote a message decides how it may end.
  const statusByMessageId = new Map(
    turns.map(({ assistantMessageId, status }) => [assistantMessageId, status]),
  );
  return rows.flatMap((row) => {
    const status = statusByMessageId.get(row.id) ?? "completed";
    if (LIVE_TURN_STATUS[status]) {
      return [];
    }
    return findUnsettledToolCallsForOutcome({
      outcome: SETTLED_TURN_OUTCOME[status],
      parts: chatMessageFromPersisted(row).parts,
    }).map(({ state, toolCallId }) => ({
      messageId: row.id,
      state,
      toolCallId,
    }));
  });
};

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
