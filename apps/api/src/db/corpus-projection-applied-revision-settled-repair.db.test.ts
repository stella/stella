import { panic } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { createCorpusProjectionAppliedRevisionSettledRepair } from "./corpus-projection-applied-revision-settled-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import appendRouteEntry from "./online-migration-entries/indexes-corpus-index-projection-states-append-route-idx";

const REPAIR = createCorpusProjectionAppliedRevisionSettledRepair({
  sleep: async () => {},
  readVerdict: async () => ({
    kind: "normal",
    signals: [
      {
        indicator: "ebs_balance",
        kind: "normal",
        value: 90,
        threshold: 70,
        observedAt: "2026-11-06T12:00:00.000Z",
        reason: "Injected health for repair semantics",
      },
    ],
  }),
});

const GENERATION = "case_law_v5";
const INDEX_ID = "case_law_v5_cs_sk";
const SETTLED_ROWS = 12;
const APPLIED_ROWS = 5;

let client: Awaited<ReturnType<typeof createTestPglite>>;

const connectionOver = (): OnlineMigrationConnection => ({
  execute: async (query, params = []) => {
    await client.query(query, [...params]);
  },
  query: async (query, params = []) =>
    (await client.query(query, [...params])).rows,
  release: () => {},
});

const entity = (offset: string) =>
  `('00000000-0000-4000-8000-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;
const revision = (offset: string) =>
  `('00000000-0000-4000-9000-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;

/**
 * The database as the deploy finds it: rows written before the triggers, so a
 * revision can already be settled while its state row still reads false.
 */
const seedBeforeTriggers = async (): Promise<void> => {
  await client.query(
    `INSERT INTO corpus_index_generations
       (family, generation, cluster, manifest_digest, status)
     VALUES ('case_law', '${GENERATION}', 'q09', $1, 'building')`,
    [corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.case_law_v5)],
  );
  await client.query(`
    ALTER TABLE corpus_index_projection_states
      DISABLE TRIGGER corpus_projection_states_revision_settled
  `);
  await client.query(`
    INSERT INTO corpus_index_projection_intents
      (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
       expected_document_count, append_started_at, append_committed_at,
       append_publish_barrier_at, applied_at, cleanup_not_before,
       cleanup_started_at, delete_opstamp, delete_task_created_at, settled_at,
       created_at, updated_at)
    SELECT
      ${revision("i")}, 'case_law', '${GENERATION}', ${entity("i")}, 1,
      lpad(to_hex(i), 64, '0'), '${INDEX_ID}', 'settled', 3,
      '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
      '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
      '2026-07-01'::timestamptz, '2026-07-01'::timestamptz, 1,
      '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
      '2026-07-01'::timestamptz, '2026-07-01'::timestamptz
    FROM generate_series(1, ${SETTLED_ROWS}) AS i
  `);
  await client.query(`
    INSERT INTO corpus_index_projection_intents
      (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
       expected_document_count, append_started_at, append_committed_at,
       applied_at, created_at, updated_at)
    SELECT
      ${revision("i")}, 'case_law', '${GENERATION}', ${entity("i")}, 1,
      lpad(to_hex(i), 64, '0'), '${INDEX_ID}', 'applied', 3,
      '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
      '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
      '2026-07-01'::timestamptz
    FROM generate_series(${SETTLED_ROWS + 1}, ${SETTLED_ROWS + APPLIED_ROWS}) AS i
  `);
  await client.query(`
    INSERT INTO corpus_index_projection_states
      (family, generation, entity_id, desired_action, desired_epoch,
       desired_fingerprint, desired_index_id, work_status, applied_action,
       applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
       applied_at, created_at, updated_at)
    SELECT
      'case_law', '${GENERATION}', ${entity("i")}, 'upsert', 2,
      lpad(to_hex(i), 64, 'd'), '${INDEX_ID}', 'eligible', 'upsert', 1,
      ${revision("i")}, lpad(to_hex(i), 64, '0'), '${INDEX_ID}',
      '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
      '2026-07-01'::timestamptz
    FROM generate_series(1, ${SETTLED_ROWS + APPLIED_ROWS}) AS i
  `);
  await client.query(`
    ALTER TABLE corpus_index_projection_states
      ENABLE TRIGGER corpus_projection_states_revision_settled
  `);
};

const countMarked = async (): Promise<{ marked: number; unmarked: number }> => {
  const row = (
    await client.query<{ marked: number; unmarked: number }>(`
      SELECT count(*) FILTER (WHERE applied_revision_settled)::int AS marked,
             count(*) FILTER (WHERE NOT applied_revision_settled)::int AS unmarked
      FROM corpus_index_projection_states
    `)
  ).rows.at(0);
  return row ?? { marked: -1, unmarked: -1 };
};

beforeEach(async () => {
  client = await createTestPglite();
});

afterEach(async () => {
  await client.close();
});

test("a fresh database owes nothing and stays complete", async () => {
  const connection = connectionOver();
  expect(await REPAIR.readCompletion(connection)).toEqual({ type: "complete" });
  expect(
    await REPAIR.repair(connection, createUngatedTableGateForTests(connection)),
  ).toEqual({
    type: "complete",
  });
  expect(await REPAIR.readCompletion(connection)).toEqual({ type: "complete" });
});

test("the walk marks every settled revision and no other, and resumes as a no-op", async () => {
  await seedBeforeTriggers();
  const connection = connectionOver();
  expect(await countMarked()).toEqual({
    marked: 0,
    unmarked: SETTLED_ROWS + APPLIED_ROWS,
  });
  expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");

  await REPAIR.repair(connection, createUngatedTableGateForTests(connection));
  expect(await countMarked()).toEqual({
    marked: SETTLED_ROWS,
    unmarked: APPLIED_ROWS,
  });
  expect(await REPAIR.readCompletion(connection)).toEqual({ type: "complete" });
});

test("the online declaration matches the index the schema declares", async () => {
  const declared =
    appendRouteEntry.values.at(0) ??
    panic("The online entry declares no index");
  const row = (
    await client.query<{ definition: string }>(
      "SELECT pg_get_indexdef($1::regclass) AS definition",
      [declared.name],
    )
  ).rows.at(0);
  expect(row?.definition).toBe(
    `CREATE INDEX ${declared.name} ${declared.definitionBody}`,
  );
});
