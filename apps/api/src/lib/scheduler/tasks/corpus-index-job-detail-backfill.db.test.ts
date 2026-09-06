import { panic } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  CORPUS_INDEX_JOB_SUCCEEDED_CHECKS,
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
  legislationDocuments,
  legislationIndexJobs,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  runCorpusIndexJobDetailBatchTx,
  validateCorpusIndexJobChecksTx,
} from "@/api/lib/scheduler/tasks/corpus-index-job-detail-backfill";
import type { CorpusIndexJobDetailFamily } from "@/api/lib/scheduler/tasks/corpus-index-job-detail-backfill";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000301",
);
const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000302",
);
const LEGISLATION_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000303",
);
const LEGISLATION_DOCUMENT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000304",
);
const REASON = "the stored payload re-parses to no document";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

type ConstraintDefinitionRow = { definition: string };

/**
 * Writes rows that predate the constraint forbidding their shape. That check
 * refuses the pair on every write, so a row holding a reason in the failure
 * column can only have been written before it was added — which is the whole
 * population this repair exists for. The constraint comes back as it was, read
 * from the catalog rather than restated here, and NOT VALID so the rows just
 * written stand exactly as the trail's own do.
 */
const asPreConstraintWriter = async (
  table: string,
  constraint: string,
  write: () => Promise<void>,
): Promise<void> => {
  const { rows } = await db.execute<ConstraintDefinitionRow>(sql`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = ${constraint}
  `);
  const definition =
    rows.at(0)?.definition ??
    panic(`The schema declares no constraint named ${constraint}`);
  await db.execute(
    sql.raw(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`),
  );
  await write();
  await db.execute(
    sql.raw(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" ${definition} NOT VALID`,
    ),
  );
};

const insertLegacyWithdrawal = async (id: string): Promise<void> => {
  await asPreConstraintWriter(
    "case_law_index_jobs",
    CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.case_law_index_jobs,
    async () => {
      await db.execute(sql`
        INSERT INTO "case_law_index_jobs"
          ("id", "decision_id", "generation", "operation", "status", "error_message")
        VALUES (
          ${id}::uuid,
          ${DECISION_ID}::uuid,
          'case_law_v5',
          'withdraw',
          'succeeded',
          ${REASON}
        )
      `);
    },
  );
};

const insertLegacyLegislationWithdrawal = async (id: string): Promise<void> => {
  await asPreConstraintWriter(
    "legislation_index_jobs",
    CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.legislation_index_jobs,
    async () => {
      await db.execute(sql`
        INSERT INTO "legislation_index_jobs"
          ("id", "document_id", "generation", "operation", "status", "error_message")
        VALUES (
          ${id}::uuid,
          ${LEGISLATION_DOCUMENT_ID}::uuid,
          'legislation_v2',
          'withdraw',
          'succeeded',
          ${REASON}
        )
      `);
    },
  );
};

type ValidatedRow = { isValidated: boolean };

/** What PostgreSQL says about the check, which is the repair's completion. */
const isCheckValidated = async (constraint: string): Promise<boolean> => {
  const { rows } = await db.execute<ValidatedRow>(sql`
    SELECT convalidated AS "isValidated"
    FROM pg_catalog.pg_constraint
    WHERE conname = ${constraint}
  `);
  return rows.at(0)?.isValidated ?? panic(`No constraint named ${constraint}`);
};

const caseLawRows = async () =>
  await db
    .select({
      detail: caseLawIndexJobs.detail,
      errorMessage: caseLawIndexJobs.errorMessage,
      id: caseLawIndexJobs.id,
    })
    .from(caseLawIndexJobs)
    .orderBy(asc(caseLawIndexJobs.id));

const runBatch = async (options: {
  family: CorpusIndexJobDetailFamily;
  cursor: string | null;
  limit?: number;
}) =>
  await db.transaction(
    async (tx) =>
      await runCorpusIndexJobDetailBatchTx(asTestRaw<Transaction>(tx), options),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

beforeEach(async () => {
  await db.delete(caseLawIndexJobs).where(sql`true`);
  await db.delete(legislationIndexJobs).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(legislationDocuments).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(legislationSources).where(sql`true`);

  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "corpus-index-job-detail-backfill",
    name: "Corpus index job detail backfill",
  });
  await db.insert(caseLawDecisions).values({
    id: DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "4 As 3/2008",
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
  });
  await db.insert(legislationSources).values({
    id: LEGISLATION_SOURCE_ID,
    adapterKey: "corpus-index-job-detail-backfill",
    name: "Corpus index job detail backfill",
  });
  await db.insert(legislationDocuments).values({
    id: LEGISLATION_DOCUMENT_ID,
    sourceId: LEGISLATION_SOURCE_ID,
    eli: "eli/cz/sb/2012/89",
    title: "Občanský zákoník",
    country: "CZE",
    language: "cs",
  });
});

afterAll(async () => {
  await client.close();
});

test("a page moves the withdrawal reasons it covers and no others", async () => {
  await insertLegacyWithdrawal("0198e331-e578-7000-8000-000000000401");
  // A failure keeps its message: the repair moves reasons, not failures.
  await db.insert(caseLawIndexJobs).values({
    id: toSafeId<"caseLawIndexJob">("0198e331-e578-7000-8000-000000000402"),
    decisionId: DECISION_ID,
    generation: "case_law_v5",
    operation: "index",
    status: "failed",
    errorMessage: "the index write did not land",
  });
  // A row the new writer wrote is already in its final shape.
  await db.insert(caseLawIndexJobs).values({
    id: toSafeId<"caseLawIndexJob">("0198e331-e578-7000-8000-000000000403"),
    decisionId: DECISION_ID,
    generation: "case_law_v5",
    operation: "withdraw",
    status: "succeeded",
    detail: REASON,
  });

  const first = await runBatch({ cursor: null, family: "case_law" });
  expect(first).toEqual({
    movedCount: 1,
    nextCursor: "0198e331-e578-7000-8000-000000000403",
  });
  expect(await caseLawRows()).toEqual([
    {
      detail: REASON,
      errorMessage: null,
      id: toSafeId<"caseLawIndexJob">("0198e331-e578-7000-8000-000000000401"),
    },
    {
      detail: null,
      errorMessage: "the index write did not land",
      id: toSafeId<"caseLawIndexJob">("0198e331-e578-7000-8000-000000000402"),
    },
    {
      detail: REASON,
      errorMessage: null,
      id: toSafeId<"caseLawIndexJob">("0198e331-e578-7000-8000-000000000403"),
    },
  ]);

  // Replaying the same page moves nothing a second time, and the walk ends
  // when the range past the cursor is empty.
  expect(await runBatch({ cursor: null, family: "case_law" })).toEqual({
    movedCount: 0,
    nextCursor: "0198e331-e578-7000-8000-000000000403",
  });
  expect(
    await runBatch({
      cursor: "0198e331-e578-7000-8000-000000000403",
      family: "case_law",
    }),
  ).toEqual({ movedCount: 0, nextCursor: null });
});

test("the walk resumes from its cursor across pages", async () => {
  const ids = [
    "0198e331-e578-7000-8000-000000000411",
    "0198e331-e578-7000-8000-000000000412",
    "0198e331-e578-7000-8000-000000000413",
  ];
  for (const id of ids) {
    await insertLegacyWithdrawal(id);
  }

  const first = await runBatch({ cursor: null, family: "case_law", limit: 2 });
  expect(first).toEqual({ movedCount: 2, nextCursor: ids[1] ?? "" });
  // The page stops where the cursor says it did: the third row is untouched.
  expect((await caseLawRows()).map(({ detail }) => detail)).toEqual([
    REASON,
    REASON,
    null,
  ]);

  const second = await runBatch({
    cursor: first.nextCursor,
    family: "case_law",
    limit: 2,
  });
  expect(second).toEqual({ movedCount: 1, nextCursor: ids[2] ?? "" });
  expect((await caseLawRows()).map(({ errorMessage }) => errorMessage)).toEqual(
    [null, null, null],
  );
});

test("legislation is walked the same way", async () => {
  const id = "0198e331-e578-7000-8000-000000000421";
  await insertLegacyLegislationWithdrawal(id);

  expect(await runBatch({ cursor: null, family: "legislation" })).toEqual({
    movedCount: 1,
    nextCursor: id,
  });
  expect(
    await db
      .select({
        detail: legislationIndexJobs.detail,
        errorMessage: legislationIndexJobs.errorMessage,
      })
      .from(legislationIndexJobs)
      .where(eq(legislationIndexJobs.documentId, LEGISLATION_DOCUMENT_ID)),
  ).toEqual([{ detail: REASON, errorMessage: null }]);
});

test("the walked trails end with both checks validated", async () => {
  await insertLegacyWithdrawal("0198e331-e578-7000-8000-000000000431");
  await insertLegacyLegislationWithdrawal(
    "0198e331-e578-7000-8000-000000000432",
  );
  // The rows exist, so the checks stand unvalidated: PostgreSQL enforces them
  // on every write and has never read what was already there.
  expect([
    await isCheckValidated(
      CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.case_law_index_jobs,
    ),
    await isCheckValidated(
      CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.legislation_index_jobs,
    ),
  ]).toEqual([false, false]);

  await runBatch({ cursor: null, family: "case_law" });
  await runBatch({ cursor: null, family: "legislation" });
  await db.transaction(
    async (tx) =>
      await validateCorpusIndexJobChecksTx(asTestRaw<Transaction>(tx)),
  );

  expect([
    await isCheckValidated(
      CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.case_law_index_jobs,
    ),
    await isCheckValidated(
      CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.legislation_index_jobs,
    ),
  ]).toEqual([true, true]);

  // Validating again is what lets the repair be retried: a validated check is
  // a no-op, not a second scan or an error.
  await db.transaction(
    async (tx) =>
      await validateCorpusIndexJobChecksTx(asTestRaw<Transaction>(tx)),
  );
  expect(
    await isCheckValidated(
      CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.case_law_index_jobs,
    ),
  ).toBe(true);
});
