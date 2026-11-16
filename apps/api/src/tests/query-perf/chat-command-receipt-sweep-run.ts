import { eq, sql } from "drizzle-orm";

import { CHAT_COMMAND_RECEIPT_RETENTION_MS } from "@stll/api-contract/chat-command";

import { organization, user } from "@/api/db/auth-schema";
import {
  chatCommandReceipts,
  chatMessages,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";
import { sweepChatCommandReceipts } from "@/api/lib/scheduler/tasks/chat-command-receipt-retention";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";

import { measureScheduledTaskReplay } from "./scheduled-task-replay";
import { QUERY_PERF_CONNECTION_SETTINGS } from "./settings";

const ORGANIZATION_ID = toSafeId<"organization">(
  "01990000-00d1-7000-8000-000000000001",
);
const USER_ID = toSafeId<"user">("01990000-00d1-7000-8000-000000000002");
const THREAD_ID = toSafeId<"chatThread">(
  "01990000-00d1-7000-8000-000000000003",
);
const MESSAGE_ID = toSafeId<"chatMessage">(
  "01990000-00d1-7000-8000-000000000004",
);
const TURN_ID = toSafeId<"chatTurn">("01990000-00d1-7000-8000-000000000005");
const NOW = new Date("2026-10-29T00:00:00Z");
/** Receipts past their retention: the run's fixed batch. */
const EXPIRED_RECEIPTS = 25;
const INSERT_CHUNK = 1000;

/** `count` receipts of the measured chat turn, all accepted at `acceptedAt`. */
const insertReceipts = async (
  db: GatedTestDb,
  count: number,
  acceptedAt: Date,
) => {
  for (let start = 0; start < count; start += INSERT_CHUNK) {
    const size = Math.min(INSERT_CHUNK, count - start);
    // db-await-in-loop: seeds the receipts in bounded chunks before the measured run.
    await db.insert(chatCommandReceipts).values(
      Array.from({ length: size }, () => ({
        acceptedAt,
        commandId: Bun.randomUUIDv7(),
        commandType: "send" as const,
        organizationId: ORGANIZATION_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        userId: USER_ID,
        workspaceId: null,
      })),
    );
  }
};

/**
 * The expired batch beside `history` receipts still inside their retention,
 * which the sweep must not walk. Every receipt names the one chat turn: the
 * sweep reads only receipt keys and times.
 */
const seedReceipts = async (db: GatedTestDb, history: number) => {
  await db
    .delete(chatThreads)
    .where(eq(chatThreads.organizationId, ORGANIZATION_ID));
  await db.insert(chatThreads).values({
    id: THREAD_ID,
    organizationId: ORGANIZATION_ID,
    title: "Command receipt measurement",
    userId: USER_ID,
    workspaceId: null,
  });
  await db.insert(chatMessages).values({
    content: toPersistedChatMessageContentV3({
      data: [{ content: "Continue", type: "text" }],
    }),
    createdAt: NOW,
    id: MESSAGE_ID,
    role: "user" as const,
    threadId: THREAD_ID,
    userId: USER_ID,
    workspaceId: null,
  });
  await db.insert(chatTurns).values({
    cancellationReason: "user-stop" as const,
    createdAt: NOW,
    id: TURN_ID,
    organizationId: ORGANIZATION_ID,
    settledAt: NOW,
    status: "cancelled" as const,
    threadId: THREAD_ID,
    userId: USER_ID,
    userMessageId: MESSAGE_ID,
    workspaceId: null,
  });
  await insertReceipts(
    db,
    EXPIRED_RECEIPTS,
    new Date(NOW.getTime() - CHAT_COMMAND_RECEIPT_RETENTION_MS - 60 * 1000),
  );
  await insertReceipts(db, history, new Date(NOW.getTime() - 60 * 1000));
  await db.execute(sql`ANALYZE chat_command_receipts`);
};

/**
 * The receipt sweep's fixed expired batch (25 receipts), measured with 1,000
 * and 10,000 receipts still inside their retention.
 */
export const measureChatCommandReceiptSweepHistory = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const { db } = openClient({ connection: QUERY_PERF_CONNECTION_SETTINGS });
  await db
    .insert(user)
    .values({
      email: "command-receipt-measurement@example.test",
      emailVerified: true,
      id: USER_ID,
      name: "Command receipt measurement",
    })
    .onConflictDoNothing();
  await db
    .insert(organization)
    .values({
      createdAt: NOW,
      id: ORGANIZATION_ID,
      name: "Command receipt measurement",
      slug: "command-receipt-measurement",
    })
    .onConflictDoNothing();
  const measurements = [];
  for (const history of [1000, 10_000]) {
    // db-await-in-loop: each history size is seeded on its own before its run is measured.
    await seedReceipts(db, history);
    // db-await-in-loop: one measured sweep per independently seeded history size.
    measurements.push({
      history,
      ...(await measureScheduledTaskReplay({
        openClient,
        label: "chat command receipt sweep",
        task: sweepChatCommandReceipts,
        now: NOW,
      })),
    });
  }
  return measurements;
};
