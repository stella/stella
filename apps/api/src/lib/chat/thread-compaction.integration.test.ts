import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Logger } from "drizzle-orm";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  CHAT_COMPACTION_MEMORY_ELIGIBILITY,
  CHAT_COMPACTION_MEMORY_EXTRACTABLE,
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { invalidateChatCompactionChain } from "@/api/handlers/chat/persistent-compaction";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { parseChatCompactionSummary } from "./compaction-summary";
import type { IncrementalSummaryPrompt } from "./compaction-summary";
import {
  estimateTextTokens,
  MESSAGE_OVERHEAD_TOKENS,
} from "./compaction-tokens";
import { chatMessageCursorCodec } from "./message-cursor";
import {
  CHAT_COMPACTION_DELTA_BATCH_MAX,
  runChatThreadCompaction,
} from "./thread-compaction";
import type { ChatCompactionOutcome } from "./thread-compaction";

// PGlite builds its schema in-process when no snapshot is present.
setDefaultTimeout(120_000);

// Exercises the compactor against a real database: that one run folds in one
// bounded batch and advances the cursor exactly once, that reruns neither
// double-summarize nor drop delta, and that no run's reads scale with thread
// length.

let testDb: TestDatabase;
let ids: TestIds;
const seededThreadIds: SafeId<"chatThread">[] = [];

// Every statement drizzle issues, so a test can assert on read shape rather
// than trusting the implementation's own accounting.
const loggedQueries: { params: unknown[]; query: string }[] = [];
const logger: Logger = {
  logQuery: (query, params) => {
    loggedQueries.push({ params, query });
  },
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (seededThreadIds.length > 0) {
      // Cascades to the seeded messages and compaction rows.
      await testDb
        .delete(chatThreads)
        .where(inArray(chatThreads.id, seededThreadIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const countedSafeDb = (): SafeDb => {
  const counted = markRlsDatabase(drizzle({ client: testDb.$client, logger }));
  return toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(counted, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
};

type SeededRole = "assistant" | "user";

type SeedThreadOptions = {
  messageCount: number;
  /** Zero-based offsets within this batch that carry a memory opt-out. */
  optedOutOffsets?: readonly number[];
  /**
   * Role for each message by thread index. Defaults to alternating turns;
   * override to build a run of one role, which is what the preserved-tail
   * budget has to cope with.
   */
  roleFor?: (index: number) => SeededRole;
  /** Append to an existing thread instead of creating one. */
  threadId?: SafeId<"chatThread">;
};

const alternatingRole = (index: number): SeededRole =>
  index % 2 === 0 ? "user" : "assistant";

/**
 * Seed a thread, or append a further batch to one. Later batches start after
 * every message already recorded, so a test can grow a thread between runs the
 * way sends do.
 */
const seedThread = async ({
  messageCount,
  optedOutOffsets = [],
  roleFor = alternatingRole,
  threadId: existingThreadId,
}: SeedThreadOptions): Promise<SafeId<"chatThread">> => {
  const threadId =
    existingThreadId ?? toSafeId<"chatThread">(Bun.randomUUIDv7());
  if (!existingThreadId) {
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "Compaction test thread",
      workspaceId: ids.wsA1,
    });
    seededThreadIds.push(threadId);
  }

  const existingCount = await countThreadMessages(threadId);
  const optedOut = new Set(optedOutOffsets);
  const base = Date.parse("2026-03-01T00:00:00.000Z");
  await testDb.insert(chatMessages).values(
    Array.from({ length: messageCount }, (_, offset) => {
      const index = existingCount + offset;
      return {
        id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
        role: roleFor(index),
        // Version-1 payloads, matching the sibling history-window fixture: the
        // compactor reads persisted content directly, so the legacy `text` key
        // is the shape most worth covering.
        content: {
          version: 1 as const,
          data: [{ type: "text" as const, text: `message ${index}` }],
        },
        memoryExtractionEligible: !optedOut.has(offset),
        createdAt: new Date(base + index),
      };
    }),
  );

  return threadId;
};

/**
 * One seeded message's token estimate, computed with the production estimator
 * rather than pinned as a literal, so a preserve budget expressed in whole
 * messages stays meaningful if the estimator changes.
 */
const MESSAGE_TOKENS_ESTIMATE =
  MESSAGE_OVERHEAD_TOKENS + estimateTextTokens("message 10");

const countThreadMessages = async (
  threadId: SafeId<"chatThread">,
): Promise<number> => {
  const rows = await testDb
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId));
  return rows.length;
};

/**
 * Invalidate the chain exactly as an edit or replay does, through the same
 * production helper, so these tests pin the guard rather than a stand-in for
 * it: if the epoch bump ever stops travelling with the staleness marking, they
 * fail.
 */
const invalidateChain = async (
  threadId: SafeId<"chatThread">,
): Promise<void> => {
  const result = await countedSafeDb()(
    async (tx) => await invalidateChatCompactionChain({ threadId, tx }),
  );
  if (Result.isError(result)) {
    throw new TypeError(`invalidation failed: ${result.error.message}`);
  }
};

const SUMMARY_MARKDOWN = [
  "## Goal",
  "Continue the matter.",
  "",
  "## Constraints",
  "- None",
  "",
  "## Progress",
  "### Done",
  "- Reviewed the transcript",
  "### In Progress",
  "- None",
  "### Blocked",
  "- None",
  "",
  "## Key Decisions",
  "- None",
  "",
  "## Next Steps",
  "- Continue",
  "",
  "## Critical Context",
  "- None",
  "",
  "<read-files>",
  "</read-files>",
  "<modified-files>",
  "</modified-files>",
].join("\n");

type RecordedRun = {
  outcome: ChatCompactionOutcome;
  prompts: IncrementalSummaryPrompt[];
  queries: { params: unknown[]; query: string }[];
};

/**
 * Run the compactor with the model replaced by a recording stub, capturing
 * both what it asked the model to summarize and every statement it issued.
 */
const runCompaction = async ({
  threadId,
  triggerTokens = 1,
  preserveTokens = 1,
  extractionFeatureEnabled = true,
  onSummarize,
  summary = SUMMARY_MARKDOWN,
}: {
  threadId: SafeId<"chatThread">;
  extractionFeatureEnabled?: boolean;
  /**
   * Runs while the summarizer is in flight, which is between the delta read
   * and the advance transaction: the window a concurrent edit would land in.
   */
  onSummarize?: () => Promise<void>;
  preserveTokens?: number;
  /** What the model returns. Whitespace stands in for an unusable response. */
  summary?: string;
  triggerTokens?: number;
}): Promise<RecordedRun> => {
  const prompts: IncrementalSummaryPrompt[] = [];
  loggedQueries.length = 0;

  const result = await runChatThreadCompaction({
    abortSignal: AbortSignal.timeout(60_000),
    dataWorkspaceIds: [ids.wsA1],
    extractionFeatureEnabled,
    orgAIConfig: null,
    organizationId: ids.orgA,
    preserveTokens,
    safeDb: countedSafeDb(),
    summarize: async (prompt) => {
      prompts.push(prompt);
      await onSummarize?.();
      return summary;
    },
    threadId,
    triggerTokens,
  });

  if (Result.isError(result)) {
    throw new TypeError(`compaction failed: ${result.error.message}`);
  }

  return { outcome: result.value, prompts, queries: [...loggedQueries] };
};

const readChain = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({
      deltaCursor: chatThreadCompactions.deltaCursor,
      firstSummarizedMessageId: chatThreadCompactions.firstSummarizedMessageId,
      lastSummarizedMessageId: chatThreadCompactions.lastSummarizedMessageId,
      memoryEligibility: chatThreadCompactions.memoryEligibility,
      memoryExtractedAt: chatThreadCompactions.memoryExtractedAt,
      status: chatThreadCompactions.status,
      summarizedMessageCount: chatThreadCompactions.summarizedMessageCount,
      totalSummarizedMessageCount:
        chatThreadCompactions.totalSummarizedMessageCount,
    })
    .from(chatThreadCompactions)
    .where(eq(chatThreadCompactions.threadId, threadId))
    .orderBy(asc(chatThreadCompactions.createdAt));

const transcriptMessageIds = (transcript: string): string[] =>
  [...transcript.matchAll(/<message index="\d+" role="[^"]*" id="([^"]+)">/gu)]
    .map((match) => match.at(1))
    .flatMap((id) => (id === undefined ? [] : [id]));

describe("chat thread compaction", () => {
  test("advances the checkpoint exactly once per run", async () => {
    const threadId = await seedThread({ messageCount: 6 });

    const run = await runCompaction({ threadId });

    expect(run.outcome.type).toBe("advanced");
    expect(run.prompts).toHaveLength(1);
    // A thread's first compaction has no checkpoint to merge.
    expect(run.prompts.at(0)?.previousCheckpoint).toBeNull();

    const chain = await readChain(threadId);
    expect(chain).toHaveLength(1);
    const checkpoint = chain.at(0);
    expect(checkpoint?.status).toBe("active");
    expect(checkpoint?.deltaCursor).toBeString();
    expect(checkpoint?.totalSummarizedMessageCount).toBe(
      checkpoint?.summarizedMessageCount ?? -1,
    );
  });

  test("successive runs partition the thread instead of resummarizing it", async () => {
    // More than one batch, so the second run has delta of its own to fold in.
    const threadId = await seedThread({
      messageCount: CHAT_COMPACTION_DELTA_BATCH_MAX + 40,
    });

    const first = await runCompaction({ threadId });
    const second = await runCompaction({ threadId });

    expect(first.outcome.type).toBe("advanced");
    expect(second.outcome.type).toBe("advanced");

    const chain = await readChain(threadId);
    // The partial unique index permits exactly one active checkpoint, and the
    // compare-and-set is what keeps it that way across runs.
    expect(chain.filter((row) => row.status === "active")).toHaveLength(1);
    expect(chain.at(-1)?.status).toBe("active");

    // The chain is a partition: each summary covers a disjoint slice, so the
    // cumulative total is the sum of the parts. A double-summarize would
    // inflate it; a dropped delta would deflate it.
    const summarizedTotal = chain.reduce(
      (total, row) => total + row.summarizedMessageCount,
      0,
    );
    expect(chain.at(-1)?.totalSummarizedMessageCount).toBe(summarizedTotal);

    // Cursors advance strictly, so no run rewinds onto messages an earlier one
    // already folded in.
    const cursors = chain.map((row) => row.deltaCursor);
    expect(new Set(cursors).size).toBe(cursors.length);

    // The second run sees only what the first left behind, and carries the
    // previous checkpoint forward rather than starting the summary over.
    const firstIds = new Set(
      transcriptMessageIds(first.prompts.at(0)?.newMessages ?? ""),
    );
    const secondIds = transcriptMessageIds(
      second.prompts.at(0)?.newMessages ?? "",
    );
    expect(secondIds.length).toBeGreaterThan(0);
    expect(secondIds.filter((id) => firstIds.has(id))).toEqual([]);
    expect(second.prompts.at(0)?.previousCheckpoint).toBe(SUMMARY_MARKDOWN);
  });

  test("two runs over the same delta advance the chain only once", async () => {
    const threadId = await seedThread({ messageCount: 8 });

    // Both runs read the same active checkpoint before either writes, which is
    // exactly what a retry after a crash between summarizing and committing
    // looks like. The compare-and-set on the checkpoint id must let only one
    // through.
    const [left, right] = await Promise.all([
      runCompaction({ threadId }),
      runCompaction({ threadId }),
    ]);

    const advanced = [left, right].filter(
      ({ outcome }) => outcome.type === "advanced",
    );
    expect(advanced).toHaveLength(1);

    const chain = await readChain(threadId);
    expect(chain).toHaveLength(1);
    const checkpoint = chain.at(0);
    expect(checkpoint?.status).toBe("active");
    // The surviving checkpoint reflects one run's work, never both summed.
    expect(checkpoint?.totalSummarizedMessageCount).toBe(
      checkpoint?.summarizedMessageCount ?? -1,
    );
  });

  test("folds in at most one batch per run and reports the rest as pending", async () => {
    const threadId = await seedThread({
      messageCount: CHAT_COMPACTION_DELTA_BATCH_MAX + 40,
    });

    const run = await runCompaction({ threadId });

    expect(run.outcome).toMatchObject({ hasMoreDelta: true, type: "advanced" });
    if (run.outcome.type === "advanced") {
      expect(run.outcome.summarizedMessageCount).toBeLessThanOrEqual(
        CHAT_COMPACTION_DELTA_BATCH_MAX,
      );
    }

    const transcriptIds = transcriptMessageIds(
      run.prompts.at(0)?.newMessages ?? "",
    );
    expect(transcriptIds.length).toBeLessThanOrEqual(
      CHAT_COMPACTION_DELTA_BATCH_MAX,
    );

    const chain = await readChain(threadId);
    expect(chain.at(0)?.summarizedMessageCount).toBeLessThanOrEqual(
      CHAT_COMPACTION_DELTA_BATCH_MAX,
    );
  });

  test("never reads the thread without a row cap", async () => {
    const threadId = await seedThread({
      messageCount: CHAT_COMPACTION_DELTA_BATCH_MAX + 40,
    });

    const run = await runCompaction({ threadId });

    const messageReads = run.queries.filter(
      ({ query }) =>
        query.includes('from "chat_messages"') && query.startsWith("select"),
    );
    expect(messageReads.length).toBeGreaterThan(0);

    // An uncapped read is exactly how lifetime history creeps back in, so the
    // assertion is on the statement, not on how many rows happened to return.
    for (const { params, query } of messageReads) {
      expect(query).toContain("limit");
      const limit = params.at(-1);
      expect(limit).toBe(CHAT_COMPACTION_DELTA_BATCH_MAX + 1);
    }
  });

  test("seeks past the checkpoint instead of rereading from the start", async () => {
    const threadId = await seedThread({
      messageCount: CHAT_COMPACTION_DELTA_BATCH_MAX + 40,
    });

    await runCompaction({ threadId });
    const second = await runCompaction({ threadId });

    const messageReads = second.queries.filter(
      ({ query }) =>
        query.includes('from "chat_messages"') && query.startsWith("select"),
    );
    // The keyset predicate against created_at is what bounds the second run to
    // the delta; without it the read would start at message zero again.
    expect(
      messageReads.some(({ query }) => query.includes('"created_at" >')),
    ).toBe(true);
  });
});

describe("chat thread compaction memory provenance", () => {
  test("a clean segment under an enabled deployment stays extractable", async () => {
    const threadId = await seedThread({ messageCount: 6 });

    await runCompaction({ threadId, extractionFeatureEnabled: true });

    const checkpoint = (await readChain(threadId)).at(-1);
    expect(checkpoint?.memoryEligibility).toBe(
      CHAT_COMPACTION_MEMORY_ELIGIBILITY.ELIGIBLE,
    );
    // A null stamp is what leaves the row visible to the extractor's queue.
    expect(checkpoint?.memoryExtractedAt).toBeNull();
  });

  test("one opted-out message keeps the summary out of the extraction queue", async () => {
    const threadId = await seedThread({
      messageCount: 6,
      optedOutOffsets: [1],
    });

    await runCompaction({ threadId, extractionFeatureEnabled: true });

    const checkpoint = (await readChain(threadId)).at(-1);
    expect(checkpoint?.memoryEligibility).toBe(
      CHAT_COMPACTION_MEMORY_ELIGIBILITY.MESSAGE_OPTED_OUT,
    );
    // The extractor claims only rows whose stamp is null, so stamping here is
    // what actually withholds the summary.
    expect(checkpoint?.memoryExtractedAt).not.toBeNull();
  });

  test("re-enabling extraction cannot mine a chain summarized while it was off", async () => {
    // The consent boundary this provenance exists for. The first segment is
    // summarized with extraction disabled; by the time the second runs the
    // deployment has been re-enabled and every new message is eligible. The
    // second summary still folds in the first, so it must stay withheld.
    const threadId = await seedThread({ messageCount: 6 });
    await runCompaction({ threadId, extractionFeatureEnabled: false });

    const afterDisabledRun = (await readChain(threadId)).at(-1);
    expect(afterDisabledRun?.memoryEligibility).toBe(
      CHAT_COMPACTION_MEMORY_ELIGIBILITY.CONSENT_INACTIVE,
    );

    await seedThread({ messageCount: 6, threadId });
    const reEnabled = await runCompaction({
      threadId,
      extractionFeatureEnabled: true,
    });
    expect(reEnabled.outcome.type).toBe("advanced");

    const chain = await readChain(threadId);
    const active = chain.filter((row) => row.status === "active");
    expect(active).toHaveLength(1);
    expect(active.at(0)?.memoryEligibility).toBe(
      CHAT_COMPACTION_MEMORY_ELIGIBILITY.CONSENT_INACTIVE,
    );
    expect(active.at(0)?.memoryExtractedAt).not.toBeNull();

    // No checkpoint anywhere in the chain became extractable after the flag
    // flipped: the verdict travels with the content, not with the deployment.
    expect(
      chain.every(
        (row) => !CHAT_COMPACTION_MEMORY_EXTRACTABLE[row.memoryEligibility],
      ),
    ).toBe(true);
  });

  test("an opt-out in an early segment withholds every later summary", async () => {
    const threadId = await seedThread({
      messageCount: 6,
      optedOutOffsets: [2],
    });
    await runCompaction({ threadId });

    await seedThread({ messageCount: 6, threadId });
    await runCompaction({ threadId });

    const chain = await readChain(threadId);
    expect(chain.length).toBeGreaterThan(1);
    expect(
      chain.every(
        (row) =>
          row.memoryEligibility ===
          CHAT_COMPACTION_MEMORY_ELIGIBILITY.MESSAGE_OPTED_OUT,
      ),
    ).toBe(true);
    expect(chain.every((row) => row.memoryExtractedAt !== null)).toBe(true);
  });
});

/**
 * The migration statement that re-anchors chains predating `delta_cursor`,
 * read from the migration itself rather than restated here. A copy would be a
 * mirror that could drift; this fails if the statement is renamed or removed.
 */
const readCursorBackfillStatement = async (): Promise<string> => {
  const migration = await Bun.file(
    new URL(
      "../../../drizzle/20260812100000_chat_incremental_compaction/migration.sql",
      import.meta.url,
    ),
  ).text();

  const statement = migration
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.trim())
    .find((chunk) => /^UPDATE "chat_thread_compactions"/mu.test(chunk));

  if (statement === undefined) {
    throw new TypeError("migration has no chat_thread_compactions backfill");
  }
  return statement;
};

const seedLegacyCheckpoint = async ({
  memoryExtractedAt,
  messageIds,
  threadId,
}: {
  memoryExtractedAt: Date | null;
  messageIds: readonly SafeId<"chatMessage">[];
  threadId: SafeId<"chatThread">;
}): Promise<void> => {
  const first = messageIds.at(0);
  const last = messageIds.at(-1);
  const firstKept = messageIds.at(-1);
  if (!first || !last || !firstKept) {
    throw new TypeError("legacy checkpoint needs a message range");
  }

  await testDb.insert(chatThreadCompactions).values({
    id: toSafeId<"chatThreadCompaction">(Bun.randomUUIDv7()),
    threadId,
    status: "active",
    summary: parseChatCompactionSummary(SUMMARY_MARKDOWN),
    summaryMarkdown: SUMMARY_MARKDOWN,
    firstSummarizedMessageId: first,
    lastSummarizedMessageId: last,
    firstKeptMessageId: firstKept,
    summarizedMessageCount: messageIds.length,
    totalTokens: 70_000,
    preservedTokens: 30_000,
    promptVersion: 1,
    memoryExtractedAt,
    // The shape a row written before these columns existed reads back as.
    deltaCursor: null,
    totalSummarizedMessageCount: 0,
    memoryEligibility: CHAT_COMPACTION_MEMORY_ELIGIBILITY.UNKNOWN,
  });
};

const readThreadMessages = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({
      cursorValue: chatMessageCursorCodec.cursorValue.as("created_at_cursor"),
      id: chatMessages.id,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

describe("chat thread compaction cursor backfill", () => {
  test("re-anchors a legacy chain on the cursor the codec would have written", async () => {
    const threadId = await seedThread({ messageCount: 8 });
    const messages = await readThreadMessages(threadId);
    const summarized = messages.slice(0, 5);
    await seedLegacyCheckpoint({
      memoryExtractedAt: null,
      messageIds: summarized.map(({ id }) => id),
      threadId,
    });

    await testDb.execute(sql.raw(await readCursorBackfillStatement()));

    const checkpoint = (await readChain(threadId)).at(-1);
    const boundary = summarized.at(-1);
    if (!boundary) {
      throw new TypeError("expected a summarized boundary");
    }

    // The migration builds the cursor in SQL while every reader decodes it with
    // the codec. A cursor this side cannot decode reads as "no cursor" and
    // silently restarts the delta at message zero, so the two must agree
    // exactly, not merely look similar.
    expect(checkpoint?.deltaCursor).toBe(
      chatMessageCursorCodec.encode(boundary.cursorValue, boundary.id),
    );
    expect(
      chatMessageCursorCodec.decode(checkpoint?.deltaCursor ?? ""),
    ).toEqual({
      id: boundary.id,
      timestamp: expect.objectContaining({ precision: "microseconds" }),
    });

    // The header count would otherwise under-report for the rest of the
    // chain's life, because the column starts at zero.
    expect(checkpoint?.totalSummarizedMessageCount).toBe(summarized.length);
  });

  test("the re-anchored chain summarizes only what it had not already", async () => {
    const threadId = await seedThread({ messageCount: 8 });
    const messages = await readThreadMessages(threadId);
    const summarized = messages.slice(0, 5);
    await seedLegacyCheckpoint({
      memoryExtractedAt: null,
      messageIds: summarized.map(({ id }) => id),
      threadId,
    });

    await testDb.execute(sql.raw(await readCursorBackfillStatement()));
    const run = await runCompaction({ threadId });

    // Without the backfill this run would read from message zero while also
    // passing the existing summary as the previous checkpoint, folding the
    // first five messages in a second time.
    const alreadySummarized = new Set(summarized.map(({ id }) => id));
    const resummarized = transcriptMessageIds(
      run.prompts.at(0)?.newMessages ?? "",
    ).filter((id) => alreadySummarized.has(toSafeId<"chatMessage">(id)));
    expect(resummarized).toEqual([]);
  });

  test("recovers extractability only where the previous writer recorded it", async () => {
    // Both branches of the backfill's CASE, in one run of the statement. The
    // stamped row must stay unknown, but asserting only that would pass even
    // if the statement never touched a row: the promotion of the unstamped row
    // is what proves it ran and that the two are distinguished.
    const unstampedThreadId = await seedThread({ messageCount: 8 });
    const stampedThreadId = await seedThread({ messageCount: 8 });

    await seedLegacyCheckpoint({
      // A null stamp IS a recorded decision: the previous writer stamped the
      // column whenever the deployment flag was off or any summarized message
      // was opted out, so its absence means every one of them was eligible.
      memoryExtractedAt: null,
      messageIds: (await readThreadMessages(unstampedThreadId))
        .slice(0, 5)
        .map(({ id }) => id),
      threadId: unstampedThreadId,
    });
    await seedLegacyCheckpoint({
      // A stamped row is ambiguous: excluded, or already mined. Provenance is
      // not recoverable, so it must not be promoted.
      memoryExtractedAt: new Date(),
      messageIds: (await readThreadMessages(stampedThreadId))
        .slice(0, 5)
        .map(({ id }) => id),
      threadId: stampedThreadId,
    });

    await testDb.execute(sql.raw(await readCursorBackfillStatement()));

    expect((await readChain(unstampedThreadId)).at(-1)?.memoryEligibility).toBe(
      CHAT_COMPACTION_MEMORY_ELIGIBILITY.ELIGIBLE,
    );
    expect((await readChain(stampedThreadId)).at(-1)?.memoryEligibility).toBe(
      CHAT_COMPACTION_MEMORY_ELIGIBILITY.UNKNOWN,
    );
  });
});

describe("chat thread compaction retry semantics", () => {
  test("an output-ceiling rejection leaves the checkpoint and delta untouched", async () => {
    const threadId = await seedThread({ messageCount: 6 });
    const outputCeilingError = new HandlerError({
      message: "AI generation did not complete",
      status: 502,
    });

    const result = await runChatThreadCompaction({
      abortSignal: AbortSignal.timeout(60_000),
      dataWorkspaceIds: [ids.wsA1],
      extractionFeatureEnabled: true,
      orgAIConfig: null,
      organizationId: ids.orgA,
      preserveTokens: 1,
      safeDb: countedSafeDb(),
      summarize: async () => {
        throw outputCeilingError;
      },
      threadId,
      triggerTokens: 1,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error.cause).toBe(outputCeilingError);
    expect(await readChain(threadId)).toEqual([]);

    const retried = await runCompaction({ threadId });
    expect(retried.outcome.type).toBe("advanced");
    expect(
      transcriptMessageIds(retried.prompts.at(0)?.newMessages ?? ""),
    ).not.toEqual([]);
  });

  test("an empty model response is reported as a failed attempt, not completion", async () => {
    const threadId = await seedThread({ messageCount: 6 });

    const run = await runCompaction({ threadId, summary: "   \n  " });

    // `up-to-date` would settle the thread and leave the delta unsummarized
    // until some later send happened to re-enqueue it. The delta is still
    // pending, so the outcome has to say so.
    expect(run.outcome.type).toBe("no-summary");
    expect(await readChain(threadId)).toEqual([]);
  });

  test("a retried run summarizes the same delta once the model answers", async () => {
    const threadId = await seedThread({ messageCount: 6 });

    const empty = await runCompaction({ threadId, summary: "" });
    const retried = await runCompaction({ threadId });

    expect(empty.outcome.type).toBe("no-summary");
    expect(retried.outcome.type).toBe("advanced");
    // Nothing was consumed by the failed attempt: the retry sees the same
    // messages, so no delta was lost to it.
    expect(
      transcriptMessageIds(retried.prompts.at(0)?.newMessages ?? ""),
    ).toEqual(transcriptMessageIds(empty.prompts.at(0)?.newMessages ?? ""));
    expect(await readChain(threadId)).toHaveLength(1);
  });
});

describe("chat thread compaction preserve budget", () => {
  const MESSAGE_COUNT = 12;

  test("stops the preserved tail at the budget across a run of assistant turns", async () => {
    // The regression, and why the roles matter: the walk used to continue past
    // the budget until the preserved window happened to begin on a user turn.
    // With alternating turns it stops within a message either way, so only an
    // unbroken run of assistant messages shows the difference. Under the old
    // rule this consumed all twelve, left nothing to summarize, and reported
    // up-to-date on a thread that was over its trigger.
    const threadId = await seedThread({
      messageCount: MESSAGE_COUNT,
      roleFor: () => "assistant",
    });

    // Every seeded message is the same size, so a budget of two of them bounds
    // the tail at two regardless of role.
    const run = await runCompaction({
      threadId,
      preserveTokens: 2 * MESSAGE_TOKENS_ESTIMATE,
      triggerTokens: 1,
    });

    expect(run.outcome.type).toBe("advanced");
    const summarized = transcriptMessageIds(
      run.prompts.at(0)?.newMessages ?? "",
    );
    expect(MESSAGE_COUNT - summarized.length).toBe(2);
  });

  test("prefers a user turn by shortening the tail, never by extending it", async () => {
    // The user-turn boundary survives as a preference. It is applied by
    // trimming, so the preserved window can only get smaller: the messages it
    // gives up move into the summary rather than over the budget.
    const threadId = await seedThread({
      messageCount: MESSAGE_COUNT,
      // A single user turn sits two messages before the end, so a two-message
      // budget starts mid-exchange and has to trim back to it.
      roleFor: (index) => (index === MESSAGE_COUNT - 2 ? "user" : "assistant"),
    });

    const run = await runCompaction({
      threadId,
      preserveTokens: 2 * MESSAGE_TOKENS_ESTIMATE,
      triggerTokens: 1,
    });

    expect(run.outcome.type).toBe("advanced");
    const preserved =
      MESSAGE_COUNT -
      transcriptMessageIds(run.prompts.at(0)?.newMessages ?? "").length;
    expect(preserved).toBeLessThanOrEqual(2);
  });

  test("always leaves something to summarize, so the thread cannot stall", async () => {
    // A budget larger than the whole batch would otherwise preserve every
    // message, leave nothing to summarize, and report up-to-date forever on a
    // thread that is over its trigger.
    const threadId = await seedThread({
      messageCount: 4,
      roleFor: () => "assistant",
    });

    const run = await runCompaction({
      threadId,
      preserveTokens: 10_000_000,
      triggerTokens: 1,
    });

    expect(run.outcome.type).toBe("advanced");
    expect(
      transcriptMessageIds(run.prompts.at(0)?.newMessages ?? "").length,
    ).toBeGreaterThan(0);
    expect(await readChain(threadId)).toHaveLength(1);
  });
});

describe("chat thread compaction invalidation guard", () => {
  test("declines to advance when an edit invalidates the chain mid-run", async () => {
    // No checkpoint yet, which is precisely where comparing checkpoint ids is
    // vacuous: invalidation has no active row to mark stale, so without the
    // epoch both sides read null and the stale summary would be accepted.
    const threadId = await seedThread({ messageCount: 6 });

    const run = await runCompaction({
      threadId,
      onSummarize: async () => {
        await invalidateChain(threadId);
      },
    });

    expect(run.outcome.type).toBe("superseded");
    // Nothing was written, so the corrected content is still unsummarized and
    // no cursor advanced past it.
    expect(await readChain(threadId)).toEqual([]);
  });

  test("still advances when nothing invalidated the chain", async () => {
    // The guard must not decline on its own: same shape, no invalidation.
    const threadId = await seedThread({ messageCount: 6 });

    const run = await runCompaction({
      threadId,
      onSummarize: async () => {
        await Promise.resolve();
      },
    });

    expect(run.outcome.type).toBe("advanced");
    expect(await readChain(threadId)).toHaveLength(1);
  });

  test("declines when an edit invalidates an existing chain mid-run", async () => {
    const threadId = await seedThread({ messageCount: 6 });
    await runCompaction({ threadId });
    const before = await readChain(threadId);

    await seedThread({ messageCount: 6, threadId });
    const run = await runCompaction({
      threadId,
      onSummarize: async () => {
        await invalidateChain(threadId);
      },
    });

    expect(run.outcome.type).toBe("superseded");
    // The invalidation retired the old checkpoint and the run added none.
    const after = await readChain(threadId);
    expect(after).toHaveLength(before.length);
    expect(after.every((row) => row.status === "stale")).toBe(true);
  });
});
