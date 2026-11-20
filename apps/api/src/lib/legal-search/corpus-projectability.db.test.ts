import { Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
  schedulerJobs,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { DEFAULT_STATEMENT_CEILING } from "@/api/lib/db/statement-ceiling";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { writeProjectedCorpusColumnsTx } from "@/api/lib/legal-search/corpus-projectability-write";
import {
  backfillLegislationCorpusStorageRow,
  readLegislationCorpusStoragePage,
} from "@/api/lib/legal-search/legislation-corpus-storage-backfill";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  backfillCaseLawRedactionTombstones,
} from "@/api/lib/scheduler/tasks/case-law-redaction-tombstone-backfill";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { heldSchedulerLease } from "@/api/tests/helpers/scheduler-lease";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const CASE_LAW_SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000501",
);
const LEGISLATION_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000502",
);
const decisionId = (n: number) =>
  toSafeId<"caseLawDecision">(
    `0198e331-e578-7000-8000-${String(600 + n).padStart(12, "0")}`,
  );
const documentId = (n: number) =>
  toSafeId<"legislationDocument">(
    `0198e331-e578-7000-8000-${String(700 + n).padStart(12, "0")}`,
  );
const HASH = "a".repeat(64);
const LEASE = "projectability-test-lease";
const JOB_ID = "test.projectability.redaction-tombstones";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const inTx = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

const register = async (
  generation: "case_law_v5" | "case_law_v6" | "legislation_v2",
) => {
  const manifest = CORPUS_INDEX_MANIFESTS[generation];
  await db.insert(corpusIndexGenerations).values({
    family: manifest.family,
    generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(manifest),
    status: "building",
  });
};

const statesOf = async (entityId: string) =>
  await db
    .select({
      generation: corpusIndexProjectionStates.generation,
      action: corpusIndexProjectionStates.desiredAction,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, entityId))
    .orderBy(corpusIndexProjectionStates.generation);

const projectDecision = async (n: number) =>
  await inTx(async (tx) => {
    const subject = { family: "case_law", entityId: decisionId(n) } as const;
    const lock = await lockActiveCorpusProjectionSourceTx(tx, subject);
    if (lock === null) {
      throw new Error("expected an active projection");
    }
    await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
      lock,
      subject,
    });
  });

// timeout: builds the PGlite schema from every migration.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);

beforeEach(async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);
  await db.delete(caseLawIndexJobs).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(legislationDocuments).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(legislationSources).where(sql`true`);
  await db.delete(schedulerJobs).where(eq(schedulerJobs.id, JOB_ID));
  await db.insert(caseLawSources).values({
    id: CASE_LAW_SOURCE_ID,
    adapterKey: "projectability",
    name: "Projectability",
  });
  await db.insert(legislationSources).values({
    id: LEGISLATION_SOURCE_ID,
    adapterKey: "projectability",
    name: "Projectability",
  });
});

afterAll(async () => {
  await client.close();
});

test("a deferred legislation document that gains its content hash is projected into every active generation in the same transaction", async () => {
  await register("legislation_v2");
  // Not projectable and held by no generation: the seeding walk defers it.
  await db.insert(legislationDocuments).values({
    id: documentId(1),
    sourceId: LEGISLATION_SOURCE_ID,
    eli: "eli/cze/sb/2020/1",
    title: "Zákon 1",
    country: "CZE",
    language: "cs",
  });
  expect(await statesOf(documentId(1))).toEqual([]);

  const written = await inTx(
    async (tx) =>
      await writeProjectedCorpusColumnsTx(tx, {
        family: "legislation",
        id: documentId(1),
        columns: {
          textS3Key: "corpus/text",
          normalizedS3Key: "corpus/sections",
          astS3Key: "corpus/ast",
          contentHash: HASH,
        },
        where: undefined,
      }),
  );
  expect(written).toBe(true);
  expect(await statesOf(documentId(1))).toEqual([
    { generation: "legislation_v2", action: "upsert" },
  ]);
});

test("the legislation storage backfill records a deferred document's first corpus write and projects it, and leaves a document changed since its read alone", async () => {
  await register("legislation_v2");
  await db.insert(legislationDocuments).values(
    [1, 2].map((n) => ({
      id: documentId(n),
      sourceId: LEGISLATION_SOURCE_ID,
      eli: `eli/cze/sb/2020/${String(n)}`,
      title: `Zákon ${String(n)}`,
      country: "CZE",
      language: "cs",
      fulltext: `Text ${String(n)}`,
    })),
  );
  const scopedDb: ScopedDb = async (work) => await inTx(work);
  const rows = await readLegislationCorpusStoragePage(scopedDb, {
    after: null,
    limit: 10,
  });
  expect(rows.map(({ id }) => id)).toEqual([documentId(1), documentId(2)]);
  const write: NonNullable<
    Parameters<typeof backfillLegislationCorpusStorageRow>[0]["write"]
  > = async ({ documentId: id }) =>
    await Promise.resolve(
      Result.ok({
        type: "written" as const,
        written: {
          textKey: `corpus/${id}/text`,
          sectionsKey: `corpus/${id}/sections`,
          astKey: `corpus/${id}/ast`,
          contentHash: HASH,
        },
      }),
    );
  // Document 2 changes after the page read it: its recording is refused.
  await db
    .update(legislationDocuments)
    .set({ title: "Zákon 2, změněný", updatedAt: new Date(Date.UTC(2030, 0)) })
    .where(eq(legislationDocuments.id, documentId(2)));

  const outcomes: string[] = [];
  for (const row of rows) {
    // db-await-in-loop: two fixture rows, in order
    outcomes.push(
      (await backfillLegislationCorpusStorageRow({ db: scopedDb, row, write }))
        .type,
    );
  }

  expect(outcomes).toEqual(["written", "skipped"]);
  expect(await statesOf(documentId(1))).toEqual([
    { generation: "legislation_v2", action: "upsert" },
  ]);
  expect(await statesOf(documentId(2))).toEqual([]);
  const stored = await db
    .select({
      id: legislationDocuments.id,
      textS3Key: legislationDocuments.textS3Key,
      contentHash: legislationDocuments.contentHash,
    })
    .from(legislationDocuments)
    .orderBy(legislationDocuments.id);
  expect(stored).toEqual([
    {
      id: documentId(1),
      textS3Key: `corpus/${documentId(1)}/text`,
      contentHash: HASH,
    },
    { id: documentId(2), textS3Key: null, contentHash: null },
  ]);
});

test("a decision's new content hash advances its states, and a refused compare-and-set writes and projects nothing", async () => {
  await db.insert(caseLawDecisions).values({
    id: decisionId(1),
    sourceId: CASE_LAW_SOURCE_ID,
    caseNumber: "1 As 1/2020",
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
  });
  await register("case_law_v5");
  await register("case_law_v6");
  // Settled with no content hash: projected as an erasure.
  await projectDecision(1);
  expect(await statesOf(decisionId(1))).toEqual([
    { generation: "case_law_v5", action: "erase" },
    { generation: "case_law_v6", action: "erase" },
  ]);

  const refused = await inTx(
    async (tx) =>
      await writeProjectedCorpusColumnsTx(tx, {
        family: "case_law",
        id: decisionId(1),
        columns: { contentHash: HASH },
        where: sql`false`,
      }),
  );
  expect(refused).toBe(false);
  expect((await statesOf(decisionId(1))).map(({ action }) => action)).toEqual([
    "erase",
    "erase",
  ]);

  const written = await inTx(
    async (tx) =>
      await writeProjectedCorpusColumnsTx(tx, {
        family: "case_law",
        id: decisionId(1),
        columns: { contentHash: HASH },
        where: undefined,
      }),
  );
  expect(written).toBe(true);
  expect(await statesOf(decisionId(1))).toEqual([
    { generation: "case_law_v5", action: "upsert" },
    { generation: "case_law_v6", action: "upsert" },
  ]);
});

const runTombstoneTask = async (database = db) => {
  const job = (
    await db
      .select()
      .from(schedulerJobs)
      .where(eq(schedulerJobs.id, JOB_ID))
      .limit(1)
  ).at(0);
  if (job === undefined) {
    throw new Error("expected scheduler job");
  }
  await backfillCaseLawRedactionTombstones(
    asTestRaw<SchedulerTaskContext>({
      db: database,
      job,
      payload: job.payload,
      dueAt: DueSlot.of(job),
      runId: createSafeId<"schedulerJobRun">(),
      scheduleContinuation: () => undefined,
      signal: new AbortController().signal,
      logger,
    }),
  );
};

test("the redaction tombstone backfill projects every decision it tombstones as an erasure in its own transaction", async () => {
  await db.insert(caseLawDecisions).values([
    {
      // Settled and searchable in both generations.
      id: decisionId(1),
      sourceId: CASE_LAW_SOURCE_ID,
      caseNumber: "1 As 1/2020",
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: HASH,
    },
    {
      // Pending and held by no generation: the backfill settles it.
      id: decisionId(2),
      sourceId: CASE_LAW_SOURCE_ID,
      caseNumber: "2 As 1/2020",
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      corpusMirrorStatus: "pending",
    },
  ]);
  await register("case_law_v5");
  await register("case_law_v6");
  await projectDecision(1);
  expect((await statesOf(decisionId(1))).map(({ action }) => action)).toEqual([
    "upsert",
    "upsert",
  ]);
  expect(await statesOf(decisionId(2))).toEqual([]);

  await db.insert(caseLawIndexJobs).values(
    [1, 2].map((n) => ({
      decisionId: decisionId(n),
      generation: "case_law_v1",
      operation: "redact" as const,
      status: "succeeded" as const,
    })),
  );
  await db.insert(schedulerJobs).values({
    description: "redaction tombstone projection test",
    id: JOB_ID,
    ...heldSchedulerLease(LEASE),
    nextRunAt: new Date("2026-08-01T00:00:00.000Z"),
    schedule: { type: "interval", everyMs: 60_000 },
    task: BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  });

  // The default-on seeding guard would fail this commit if the settled
  // pending decision were left with no state.
  await runTombstoneTask();

  const rows = await db
    .select({
      id: caseLawDecisions.id,
      status: caseLawDecisions.corpusMirrorStatus,
      redacted: sql<boolean>`${caseLawDecisions.redactedAt} IS NOT NULL`,
    })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.sourceId, CASE_LAW_SOURCE_ID),
        sql`${caseLawDecisions.contentHash} IS NULL`,
      ),
    )
    .orderBy(caseLawDecisions.id);
  expect(rows).toEqual([
    { id: decisionId(1), status: "settled", redacted: true },
    { id: decisionId(2), status: "settled", redacted: true },
  ]);
  for (const n of [1, 2]) {
    expect(await statesOf(decisionId(n))).toEqual([
      { generation: "case_law_v5", action: "erase" },
      { generation: "case_law_v6", action: "erase" },
    ]);
  }
});

test("a full redaction tombstone page across two sources fits the scheduler's default statement ceiling", async () => {
  const otherSourceId = toSafeId<"caseLawSource">(
    "0198e331-e578-7000-8000-000000000503",
  );
  await db.insert(caseLawSources).values({
    id: otherSourceId,
    adapterKey: "projectability-other",
    name: "Projectability other",
  });
  // More audited decisions than one page holds, across two sources; the
  // first source alone exceeds one projection batch.
  const audited = Array.from({ length: 80 }, (_, index) => index + 1);
  await db.insert(caseLawDecisions).values(
    audited.map((n) => ({
      id: decisionId(n),
      sourceId: n <= 40 ? CASE_LAW_SOURCE_ID : otherSourceId,
      caseNumber: `${String(n)} As 1/2020`,
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: HASH,
    })),
  );
  await register("case_law_v5");
  await register("case_law_v6");
  await db.insert(caseLawIndexJobs).values(
    audited.map((n) => ({
      decisionId: decisionId(n),
      generation: "case_law_v1",
      operation: "redact" as const,
      status: "succeeded" as const,
    })),
  );
  await db.insert(schedulerJobs).values({
    description: "redaction tombstone statement ceiling test",
    id: JOB_ID,
    ...heldSchedulerLease(LEASE),
    nextRunAt: new Date("2026-08-01T00:00:00.000Z"),
    schedule: { type: "interval", everyMs: 60_000 },
    task: BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  });
  let statements = 0;
  const counted = drizzle({
    client,
    logger: {
      logQuery: () => {
        statements += 1;
      },
    },
  });

  await runTombstoneTask(counted);

  const tombstoned = await db
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(sql`${caseLawDecisions.redactedAt} IS NOT NULL`)
    .orderBy(caseLawDecisions.id);
  expect(tombstoned.length).toBeGreaterThan(40);
  expect(tombstoned.length).toBeLessThan(audited.length);
  for (const { id } of tombstoned) {
    expect(await statesOf(id)).toEqual([
      { generation: "case_law_v5", action: "erase" },
      { generation: "case_law_v6", action: "erase" },
    ]);
  }
  // The ceiling also counts the page's one transaction round trip.
  expect(statements + 1).toBeLessThanOrEqual(DEFAULT_STATEMENT_CEILING);
});
