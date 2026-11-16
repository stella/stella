import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatRunLogEntries,
  chatRunLogs,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  createApprovalHarness,
} from "@/api/tests/helpers/chat-approval-harness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A turn that pauses for an approval ends its stream with a messages snapshot,
// which the delivery log stores as one entry before the page reads it. The
// page already holds every message the thread stored before the turn, so the
// snapshot must not carry them: an entry that grew with the thread would
// eventually outgrow what one log entry may hold, and every long enough
// thread would then lose its approval turns.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

/** The bytes the delivery log weighs an entry at (`chunkBytes`). */
const entryBytes = (chunk: StreamChunk): number =>
  Buffer.byteLength(JSON.stringify(chunk));

/** Every messages snapshot the thread's delivery logs stored. */
const storedSnapshots = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({ chunk: chatRunLogEntries.chunk })
      .from(chatRunLogEntries)
      .innerJoin(
        chatRunLogs,
        and(
          eq(chatRunLogs.organizationId, chatRunLogEntries.organizationId),
          eq(chatRunLogs.runId, chatRunLogEntries.runId),
        ),
      )
      .innerJoin(chatTurns, eq(chatTurns.id, chatRunLogs.turnId))
      .where(eq(chatTurns.threadId, threadId))
  )
    .map(({ chunk }) => chunk)
    .filter((chunk) => chunk.type === EventType.MESSAGES_SNAPSHOT);

const REPLY_BYTES = 24 * 1024;

/** `bytes` of prose that never repeats, so no loop guard cuts the reply. */
const variedText = (bytes: number): string => {
  const words: string[] = [];
  let length = 0;
  while (length < bytes) {
    const word = Bun.randomUUIDv7().slice(-12);
    words.push(word);
    length += word.length + 1;
  }
  return words.join(" ");
};

/**
 * The bytes of the largest snapshot the approval turn's delivery log stores,
 * after `earlierTurns` answered turns of `REPLY_BYTES` each.
 */
const approvalSnapshotBytes = async (earlierTurns: number) => {
  const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const client = await harness.openWebClient(threadId);
  try {
    for (let turn = 0; turn < earlierTurns; turn += 1) {
      harness.script(threadId, [
        {
          finishReason: "stop",
          text: variedText(REPLY_BYTES),
          type: "text",
        },
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), `Question ${turn}`);
    }
    harness.script(threadId, [
      {
        arguments: approvalToolArguments("NDA"),
        toolCallId: "call-NDA",
        toolName: APPROVAL_TOOL_NAME,
        type: "tool-call",
      },
    ]);
    await client.sendUserMessage(Bun.randomUUIDv7(), "Delete the NDA");
    await harness.expectSoundWebClient({ client, threadId });
    // Only the approval turn pauses, so every stored snapshot is its own.
    const snapshots = await storedSnapshots(threadId);
    // The fixture must reach the boundary: the approval turn pauses with a
    // snapshot, and the earlier turns stored what it would otherwise repeat.
    expect(snapshots.length).toBeGreaterThan(0);
    const stored = await harness.readThreadMessages(threadId);
    expect(stored.length).toBe(earlierTurns * 2 + 2);
    return Math.max(...snapshots.map(entryBytes));
  } finally {
    client.dispose();
    await harness.close();
  }
};

describe("an approval turn's messages snapshot", () => {
  test("weighs the same however much the thread stored before the turn", async () => {
    const short = await approvalSnapshotBytes(1);
    const long = await approvalSnapshotBytes(4);
    // Three more stored turns add over 3 * REPLY_BYTES of history; the
    // snapshot may differ only by incidental bytes (ids, timestamps), and
    // carries none of the stored replies.
    expect(Math.abs(long - short)).toBeLessThan(256);
    expect(long).toBeLessThan(REPLY_BYTES);
  });
});
