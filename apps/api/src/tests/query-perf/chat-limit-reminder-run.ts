import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import {
  chatLimitReminders,
  chatMessages,
  chatThreads,
  chatTurns,
  notifications,
} from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId, type SafeId, toSafeId } from "@/api/lib/branded-types";
import { sendChatLimitReminders } from "@/api/lib/scheduler/tasks/chat-limit-reminders";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";

import { measureScheduledTaskReplay } from "./scheduled-task-replay";
import { QUERY_PERF_CONNECTION_SETTINGS } from "./settings";

const ORGANIZATION_ID = toSafeId<"organization">(
  "01990000-00c2-7000-8000-000000000001",
);
const USER_ID = toSafeId<"user">("01990000-00c2-7000-8000-000000000002");
const NOW = new Date("2026-10-29T00:00:00Z");
const ASKED_AT = new Date("2026-10-28T00:00:00Z");
/** Chats whose reminder is due; the last few were continued since. */
const DUE_CHATS = 25;
const CONTINUED_CHATS = 5;
const INSERT_CHUNK = 1000;

type SeededTurn = {
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
};

/** One turn per chat, on a question of its own, settled or still waiting. */
const addTurns = async (
  db: GatedTestDb,
  turns: readonly (SeededTurn & { questionId: SafeId<"chatMessage"> })[],
  { cancelled, at }: { cancelled: boolean; at: Date },
) => {
  await db.insert(chatMessages).values(
    turns.map(({ threadId, questionId }) => ({
      content: toPersistedChatMessageContentV3({
        data: [{ content: "Continue", type: "text" }],
      }),
      createdAt: at,
      id: questionId,
      role: "user" as const,
      threadId,
      userId: USER_ID,
      workspaceId: null,
    })),
  );
  await db.insert(chatTurns).values(
    turns.map(({ threadId, turnId, questionId }) => ({
      ...(cancelled
        ? {
            cancellationReason: "user-stop" as const,
            settledAt: new Date(at.getTime() + 1000),
            status: "cancelled" as const,
          }
        : {
            leaseExpiresAt: new Date(at.getTime() + 60 * 60 * 1000),
            status: "accepted" as const,
          }),
      createdAt: at,
      id: turnId,
      organizationId: ORGANIZATION_ID,
      threadId,
      userId: USER_ID,
      userMessageId: questionId,
      workspaceId: null,
    })),
  );
};

/** A chat of the measured member with one turn on a question of its own. */
const seedChats = async (
  db: GatedTestDb,
  count: number,
  { cancelled }: { cancelled: boolean },
): Promise<SeededTurn[]> => {
  const chats = Array.from({ length: count }, () => ({
    threadId: createSafeId<"chatThread">(),
    turnId: createSafeId<"chatTurn">(),
    questionId: createSafeId<"chatMessage">(),
  }));
  if (chats.length === 0) {
    return [];
  }
  await db.insert(chatThreads).values(
    chats.map(({ threadId }) => ({
      id: threadId,
      organizationId: ORGANIZATION_ID,
      title: "Reminder measurement",
      userId: USER_ID,
      workspaceId: null,
    })),
  );
  await addTurns(db, chats, { cancelled, at: ASKED_AT });
  return chats;
};

/**
 * The member's due reminders, a few of them on chats continued since, beside
 * `history` reminders not yet due, which the sweep must not walk.
 */
const seedReminders = async (db: GatedTestDb, history: number) => {
  await db
    .delete(chatThreads)
    .where(eq(chatThreads.organizationId, ORGANIZATION_ID));
  await db
    .delete(notifications)
    .where(eq(notifications.organizationId, ORGANIZATION_ID));
  const due = await seedChats(db, DUE_CHATS, { cancelled: true });
  // A newer turn continued these chats, so their reminder sends nothing.
  await addTurns(
    db,
    due.slice(0, CONTINUED_CHATS).map(({ threadId }) => ({
      threadId,
      turnId: createSafeId<"chatTurn">(),
      questionId: createSafeId<"chatMessage">(),
    })),
    { cancelled: false, at: new Date(ASKED_AT.getTime() + 60 * 1000) },
  );
  await db.insert(chatLimitReminders).values(
    due.map(({ threadId, turnId }) => ({
      organizationId: ORGANIZATION_ID,
      remindAt: new Date(NOW.getTime() - 60 * 1000),
      threadId,
      turnId,
      userId: USER_ID,
    })),
  );
  // Reminders not yet due name a turn of their own chat; one chat's turn
  // stands in for each, since the sweep never reads them.
  const [anchor] = await seedChats(db, 1, { cancelled: true });
  const anchorTurnId = anchor?.turnId ?? panic("The history needs a turn");
  for (let start = 0; start < history; start += INSERT_CHUNK) {
    const size = Math.min(INSERT_CHUNK, history - start);
    const threadIds = Array.from({ length: size }, () =>
      createSafeId<"chatThread">(),
    );
    // db-await-in-loop: seeds the not-yet-due history in bounded chunks before the measured run.
    await db.insert(chatThreads).values(
      threadIds.map((id) => ({
        id,
        organizationId: ORGANIZATION_ID,
        title: "Reminder measurement",
        userId: USER_ID,
        workspaceId: null,
      })),
    );
    // db-await-in-loop: each history chat gets its not-yet-due reminder in the same chunk.
    await db.insert(chatLimitReminders).values(
      threadIds.map((threadId) => ({
        organizationId: ORGANIZATION_ID,
        remindAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        threadId,
        turnId: anchorTurnId,
        userId: USER_ID,
      })),
    );
  }
  await db.execute(
    sql`ANALYZE chat_limit_reminders, chat_threads, chat_turns, notifications`,
  );
};

/**
 * The reminder sweep's fixed due batch (25 reminders, 5 of them on chats
 * continued since), measured with 1,000 and 10,000 reminders not yet due.
 */
export const measureChatLimitReminderHistory = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const { db } = openClient({ connection: QUERY_PERF_CONNECTION_SETTINGS });
  await db
    .insert(user)
    .values({
      email: "reminder-measurement@example.test",
      emailVerified: true,
      id: USER_ID,
      name: "Reminder measurement",
    })
    .onConflictDoNothing();
  await db
    .insert(organization)
    .values({
      createdAt: NOW,
      id: ORGANIZATION_ID,
      name: "Reminder measurement",
      slug: "reminder-measurement",
    })
    .onConflictDoNothing();
  const measurements = [];
  for (const history of [1000, 10_000]) {
    // db-await-in-loop: each history size is seeded on its own before its run is measured.
    await seedReminders(db, history);
    // db-await-in-loop: one measured sweep per independently seeded history size.
    measurements.push({
      history,
      ...(await measureScheduledTaskReplay({
        openClient,
        label: "chat limit reminder",
        task: sendChatLimitReminders,
        now: NOW,
      })),
    });
  }
  return measurements;
};
