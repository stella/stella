/**
 * Flip parity with more old deletes awaiting settlement than its walk cap,
 * each beside an applied replacement, in a stored-revision candidate (v10,
 * against v7 serving): every decision reads as shown, so the verdict is no
 * regression rather than a capped walk. Rows are stood up in bulk; the
 * guarded path to the same rows is in
 * `corpus-index-projection-append-behind-cleanup.db.test.ts`, and the plan of
 * this walk at 50,000 deletes in
 * `corpus-index-flip-parity-at-risk-plan.db.test.ts`.
 */
import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_FLIP_WALK_CAP,
  readCorpusIndexFlipParity,
} from "@/api/lib/legal-search/corpus-index-flip-parity";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SERVING = "case_law_v7";
const CANDIDATE = "case_law_v10";
const DECISIONS = CORPUS_INDEX_FLIP_WALK_CAP + 1;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <T>(
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

const entity = "('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid";
const revision = (prefix: string) =>
  `('00000000-0000-4000-${prefix}-' || lpad(to_hex(i), 12, '0'))::uuid`;
const series = `generate_series(1, ${String(DECISIONS)}) AS i`;

/** One applied, named copy of every decision in `generation`. */
const seedShown = async (generation: string, prefix: string): Promise<void> => {
  const indexId = `${generation}_pol`;
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id,
         status, expected_document_count, append_started_at,
         append_committed_at, append_publish_barrier_at, applied_at,
         created_at, updated_at)
      SELECT ${revision(prefix)}, 'case_law', '${generation}', ${entity}, 1,
        lpad('1', 64, '0'), '${indexId}', 'applied', 1, '2026-08-26',
        '2026-08-26', '2026-08-26', '2026-08-26', '2026-08-26', '2026-08-26'
      FROM ${series}
    `),
  );
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, applied_action,
         applied_epoch, applied_revision, applied_fingerprint,
         applied_index_id, applied_at, created_at, updated_at)
      SELECT 'case_law', '${generation}', ${entity}, 'upsert', 1,
        lpad('1', 64, '0'), '${indexId}', 'eligible', 'upsert', 1,
        ${revision(prefix)}, lpad('1', 64, '0'), '${indexId}', '2026-08-26',
        '2026-08-01', '2026-08-26'
      FROM ${series}
    `),
  );
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  for (const generation of [SERVING, CANDIDATE] as const) {
    // db-await-in-loop: the two registry rows, in order
    await db.insert(corpusIndexGenerations).values({
      family: "case_law",
      generation,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[generation],
      ),
      status: generation === SERVING ? "serving" : "building",
    });
  }
  await seedShown(SERVING, "9007");
  await seedShown(CANDIDATE, "9b10");
  // Each candidate decision's first revision, unnamed, its delete waiting.
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id,
         status, append_started_at, append_publish_barrier_at,
         cleanup_not_before, cleanup_started_at, cleanup_attempts,
         delete_opstamp, delete_task_created_at, created_at, updated_at)
      SELECT ${revision("9a10")}, 'case_law', '${CANDIDATE}', ${entity}, 1,
        lpad('1', 64, '0'), '${CANDIDATE}_pol', 'cleanup_committed',
        '2026-08-25', '2026-08-25', '2026-08-25', '2026-08-25', 1, 3,
        '2026-08-25', '2026-08-25', '2026-08-25'
      FROM ${series}
    `),
  );
});

afterAll(async () => {
  await client.close();
});

test("more deletes in flight than the parity walk's cap, each beside an applied replacement, still read as no regression", async () => {
  const parity = await readCorpusIndexFlipParity({
    runInTransaction,
    family: "case_law",
    candidate: CANDIDATE,
    exemptMinutes: 0,
    coverage: { pageSize: 5000, pageBudget: 100, resumeFrom: null },
  });
  if (!Result.isOk(parity)) {
    return panic(
      `Flip parity read failed: ${parity.error.message}`,
      parity.error,
    );
  }
  expect(parity.value.regressions).toMatchObject({
    type: "exact",
    walked: { atRisk: 0 },
  });
  expect(parity.value.verdict).toEqual({ type: "no_regression" });
});
