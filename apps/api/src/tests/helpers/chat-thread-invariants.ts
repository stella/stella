import { panic } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

import { chatMessages, chatTurns } from "@/api/db/schema";
import {
  chatMessageFromPersisted,
  getAwaitingUserInteractions,
} from "@/api/handlers/chat/chat-message-parts";
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

/** A settled turn whose answer stores a different outcome. */
type TurnOutcomeMismatch = {
  messageId: SafeId<"chatMessage">;
  stored: ChatTurnOutcome | null;
  turn: {
    id: SafeId<"chatTurn">;
    reason: string | null;
    status: ChatTurnStatus;
  };
};

/** The outcome a settled turn row records, as its message would store it;
 *  null while the turn still writes its message. */
const rowOutcome = (turn: {
  cancellationReason: string | null;
  interruptionReason: string | null;
  status: ChatTurnStatus;
}): { reason: string | null; type: ChatTurnOutcome["type"] } | null => {
  switch (turn.status) {
    case "accepted":
    case "running":
      return null;
    case "awaiting-user":
    case "completed":
    case "failed":
      return { reason: null, type: turn.status };
    case "cancelled":
      return { reason: turn.cancellationReason, type: turn.status };
    case "interrupted":
      return { reason: turn.interruptionReason, type: turn.status };
    default:
      turn.status satisfies never;
      return panic(`Unhandled status: ${String(turn.status)}`);
  }
};

const storedReason = (outcome: ChatTurnOutcome): string | null =>
  outcome.type === "cancelled" || outcome.type === "interrupted"
    ? outcome.reason
    : null;

/**
 * Persisted-thread invariant: the turn row and the message it settled say the
 * same thing. Every writer that ends a turn writes both, so a mismatch is the
 * two records drifting. A turn's answer is the message its row names or,
 * once it ended without one (cancelled or interrupted rows name none), the
 * assistant message that follows its user message. Only the latest turn of a
 * user message is held to it: an earlier one's answer was replaced. A turn
 * that stored no answer has nothing to disagree with. Returns the
 * violations; a sound thread returns [].
 */
export const findTurnOutcomeMismatches = async ({
  db,
  threadId,
}: {
  db: TestDatabase;
  threadId: SafeId<"chatThread">;
}): Promise<TurnOutcomeMismatch[]> => {
  const [rows, turns] = await Promise.all([
    db
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
    db
      .select({
        assistantMessageId: chatTurns.assistantMessageId,
        cancellationReason: chatTurns.cancellationReason,
        id: chatTurns.id,
        interruptionReason: chatTurns.interruptionReason,
        status: chatTurns.status,
        userMessageId: chatTurns.userMessageId,
      })
      .from(chatTurns)
      .where(eq(chatTurns.threadId, threadId))
      .orderBy(asc(chatTurns.createdAt), asc(chatTurns.id)),
  ]);
  const latestTurnByUserMessage = new Map(
    turns.map((turn) => [turn.userMessageId, turn]),
  );
  const answerByUserMessage = new Map<string, (typeof rows)[number]>();
  let lastUserMessageId: string | null = null;
  for (const row of rows) {
    if (row.role === "user") {
      lastUserMessageId = row.id;
    } else if (
      row.role === "assistant" &&
      lastUserMessageId !== null &&
      !answerByUserMessage.has(lastUserMessageId)
    ) {
      answerByUserMessage.set(lastUserMessageId, row);
    }
  }
  return [...latestTurnByUserMessage.values()].flatMap((turn) => {
    const expected = rowOutcome(turn);
    const answer =
      turn.assistantMessageId === null
        ? answerByUserMessage.get(turn.userMessageId)
        : rows.find(({ id }) => id === turn.assistantMessageId);
    if (expected === null || answer === undefined) {
      return [];
    }
    const stored = chatMessageFromPersisted(answer).metadata?.turnOutcome;
    if (
      stored !== undefined &&
      stored.type === expected.type &&
      storedReason(stored) === expected.reason
    ) {
      return [];
    }
    return [
      {
        messageId: answer.id,
        stored: stored ?? null,
        turn: { id: turn.id, reason: expected.reason, status: turn.status },
      },
    ];
  });
};

/** An interaction the stored thread offers: a tool call the client answers,
 *  on a message an `awaiting-user` turn owns. */
export type OfferedInteraction = {
  kind: ReturnType<typeof getAwaitingUserInteractions>[number]["type"];
  messageId: SafeId<"chatMessage">;
  state: ToolCallState;
  toolCallId: string;
};

/**
 * The interactions the stored thread offers the user: what each message an
 * `awaiting-user` turn owns awaits.
 */
export const findOfferedInteractions = async ({
  db,
  threadId,
}: {
  db: TestDatabase;
  threadId: SafeId<"chatThread">;
}): Promise<OfferedInteraction[]> => {
  const [rows, owners] = await Promise.all([
    db
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
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
    owners.map(({ assistantMessageId }) => assistantMessageId),
  );
  return rows
    .filter(({ id }) => ownedMessageIds.has(id))
    .flatMap((row) => {
      const message = chatMessageFromPersisted(row);
      // The production reader of what a turn awaits, so this lists exactly
      // what a continuation is validated against.
      return getAwaitingUserInteractions(message).flatMap(
        ({ toolCallId, type }) => {
          const part = message.parts.find(
            (candidate) =>
              candidate.type === "tool-call" && candidate.id === toolCallId,
          );
          return part?.type === "tool-call"
            ? [{ kind: type, messageId: row.id, state: part.state, toolCallId }]
            : [];
        },
      );
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
  const [
    unownedPendingInteractions,
    unsettledToolCalls,
    turnOutcomeMismatches,
  ] = await Promise.all([
    findUnownedPendingInteractions({ db, threadId }),
    findUnsettledToolCalls({ db, threadId }),
    findTurnOutcomeMismatches({ db, threadId }),
  ]);
  return {
    turnOutcomeMismatches,
    unownedPendingInteractions,
    unsettledToolCalls,
  };
};
