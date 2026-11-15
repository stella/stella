import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v5";
const INDEX_ID = "case_law_v5_cs_sk";
const ENTITY = "00000000-0000-4000-8000-000000000001";
const FIRST = "00000000-0000-4000-9000-000000000001";
const SECOND = "00000000-0000-4000-9000-000000000002";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
});

afterEach(async () => {
  await client.close();
});

const insertApplied = async (id: string, epoch: number): Promise<void> => {
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         applied_at, created_at, updated_at)
      VALUES
        ('${id}', 'case_law', '${GENERATION}', '${ENTITY}', ${epoch},
         lpad('${epoch}', 64, '0'), '${INDEX_ID}', 'applied', 3,
         '2026-07-01', '2026-07-01', '2026-07-01', '2026-07-01', '2026-07-01')
    `),
  );
};

const SETTLE = (id: string) => `
  UPDATE corpus_index_projection_intents
  SET status = 'settled', append_publish_barrier_at = '2026-07-01',
      cleanup_not_before = '2026-07-01', cleanup_started_at = '2026-07-01',
      delete_opstamp = 1, delete_task_created_at = '2026-07-01',
      settled_at = '2026-07-02'
  WHERE id = '${id}'
`;

const REOPEN = (id: string) => `
  UPDATE corpus_index_projection_intents
  SET status = 'cleanup_pending', cleanup_started_at = NULL,
      delete_opstamp = NULL, delete_task_created_at = NULL, settled_at = NULL
  WHERE id = '${id}'
`;

const insertState = async (revision: string, epoch: number): Promise<void> => {
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, applied_action,
         applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
         applied_at, created_at, updated_at)
      VALUES
        ('case_law', '${GENERATION}', '${ENTITY}', 'upsert', ${epoch + 1},
         lpad('${epoch + 1}', 64, '0'), '${INDEX_ID}', 'eligible', 'upsert',
         ${epoch}, '${revision}', lpad('${epoch}', 64, '0'), '${INDEX_ID}',
         '2026-07-01', '2026-07-01', '2026-07-01')
    `),
  );
};

const settledFlag = async (): Promise<boolean> => {
  const { rows } = await client.query<{ settled: boolean }>(
    `SELECT applied_revision_settled AS settled
     FROM corpus_index_projection_states
     WHERE entity_id = '${ENTITY}'`,
  );
  return rows.at(0)?.settled === true;
};

test("the flag follows the applied revision into and out of settled", async () => {
  await insertApplied(FIRST, 1);
  await insertState(FIRST, 1);
  expect(await settledFlag()).toBe(false);

  await db.execute(sql.raw(SETTLE(FIRST)));
  expect(await settledFlag()).toBe(true);

  await db.execute(sql.raw(REOPEN(FIRST)));
  expect(await settledFlag()).toBe(false);
});

test("a state written over an already settled revision reads settled", async () => {
  await insertApplied(FIRST, 1);
  await db.execute(sql.raw(SETTLE(FIRST)));
  await insertState(FIRST, 1);
  expect(await settledFlag()).toBe(true);
});

test("naming a new revision does not inherit the old revision's answer", async () => {
  await insertApplied(FIRST, 1);
  await insertState(FIRST, 1);
  await db.execute(sql.raw(SETTLE(FIRST)));
  expect(await settledFlag()).toBe(true);

  await insertApplied(SECOND, 2);
  await db.execute(
    sql.raw(`
      UPDATE corpus_index_projection_states
      SET applied_revision = '${SECOND}', applied_epoch = 2,
          applied_fingerprint = lpad('2', 64, '0')
      WHERE entity_id = '${ENTITY}'
    `),
  );
  expect(await settledFlag()).toBe(false);
});

test("settling a revision the row no longer names leaves the row alone", async () => {
  await insertApplied(FIRST, 1);
  await insertApplied(SECOND, 2);
  await insertState(SECOND, 2);
  await db.execute(sql.raw(SETTLE(FIRST)));
  expect(await settledFlag()).toBe(false);
});

test("a direct write cannot claim a settlement that did not happen", async () => {
  await insertApplied(FIRST, 1);
  await insertState(FIRST, 1);
  await db.execute(
    sql.raw(`
      UPDATE corpus_index_projection_states
      SET applied_revision_settled = true
      WHERE entity_id = '${ENTITY}'
    `),
  );
  expect(await settledFlag()).toBe(false);
});
