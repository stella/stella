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
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import type { IncrementalSummaryPrompt } from "./compaction-summary";
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

const seedThread = async (
  messageCount: number,
): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "Compaction test thread",
    workspaceId: ids.wsA1,
  });
  seededThreadIds.push(threadId);

  const base = Date.parse("2026-03-01T00:00:00.000Z");
  await testDb.insert(chatMessages).values(
    Array.from({ length: messageCount }, (_, index) => ({
      id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      // Version-1 payloads, matching the sibling history-window fixture: the
      // compactor reads persisted content directly, so the legacy `text` key
      // is the shape most worth covering.
      content: {
        version: 1 as const,
        data: [{ type: "text" as const, text: `message ${index}` }],
      },
      createdAt: new Date(base + index),
    })),
  );

  return threadId;
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
}: {
  threadId: SafeId<"chatThread">;
  preserveTokens?: number;
  triggerTokens?: number;
}): Promise<RecordedRun> => {
  const prompts: IncrementalSummaryPrompt[] = [];
  loggedQueries.length = 0;

  const result = await runChatThreadCompaction({
    abortSignal: AbortSignal.timeout(60_000),
    dataWorkspaceIds: [ids.wsA1],
    orgAIConfig: null,
    organizationId: ids.orgA,
    preserveTokens,
    safeDb: countedSafeDb(),
    summarize: async (prompt) => {
      prompts.push(prompt);
      return await Promise.resolve(SUMMARY_MARKDOWN);
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
    const threadId = await seedThread(6);

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
    const threadId = await seedThread(CHAT_COMPACTION_DELTA_BATCH_MAX + 40);

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
    const threadId = await seedThread(8);

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
    const threadId = await seedThread(CHAT_COMPACTION_DELTA_BATCH_MAX + 40);

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
    const threadId = await seedThread(CHAT_COMPACTION_DELTA_BATCH_MAX + 40);

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
    const threadId = await seedThread(CHAT_COMPACTION_DELTA_BATCH_MAX + 40);

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
