/**
 * The plan of the flip parity's at-risk walk for a stored-revision candidate
 * with a large delete backlog: 50,000 decisions, each replaced beside its
 * first revision's delete. The walk reads the delete-unproven partial index
 * as a bounded range, probes each revision's state by primary key, sorts only
 * what survives that probe, and walks nothing here.
 */
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { Temporal } from "@stll/time";

import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_FLIP_AT_RISK_SCAN_CAP,
  corpusIndexFlipRegressionQuery,
} from "@/api/lib/legal-search/corpus-index-flip-parity";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { planLines } from "@/api/tests/helpers/explain-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SERVING = "case_law_v7";
const CANDIDATE = "case_law_v10";
const INDEX_ID = "case_law_v10_pol";
const BACKLOG = 50_000;
const PAIR = {
  family: "case_law",
  serving: SERVING,
  candidate: CANDIDATE,
} as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const entity = (offset: string) =>
  `('00000000-0000-4000-8000-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;
const revision = (prefix: string, offset: string) =>
  `('00000000-0000-4000-${prefix}-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;

/**
 * The backlog as a release leaves it: the first revision of each decision
 * `cleanup_committed` and unnamed, its replacement applied and named. Rows
 * are stood up directly, in bulk; this suite reads the plan and installs no
 * transition guard.
 */
const seedBacklog = async () => {
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
  const series = `generate_series(1, ${String(BACKLOG)}) AS i`;
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id,
         status, expected_document_count, append_started_at,
         append_committed_at, append_publish_barrier_at, applied_at,
         created_at, updated_at)
      SELECT ${revision("b000", "i")}, 'case_law', '${CANDIDATE}', ${entity("i")},
        1, lpad('1', 64, '0'), '${INDEX_ID}', 'applied', 1,
        '2026-08-26', '2026-08-26', '2026-08-26', '2026-08-26',
        '2026-08-26', '2026-08-26'
      FROM ${series}
    `),
  );
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id,
         status, append_started_at, append_publish_barrier_at,
         cleanup_not_before, cleanup_started_at, cleanup_attempts,
         delete_opstamp, delete_task_created_at, created_at, updated_at)
      SELECT ${revision("a000", "i")}, 'case_law', '${CANDIDATE}', ${entity("i")},
        1, lpad('1', 64, '0'), '${INDEX_ID}', 'cleanup_committed',
        '2026-08-25', '2026-08-25', '2026-08-25',
        '2026-08-25'::timestamptz + (i || ' seconds')::interval, 1, 3,
        '2026-08-25', '2026-08-25', '2026-08-25'
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
      SELECT 'case_law', '${CANDIDATE}', ${entity("i")}, 'upsert', 1,
        lpad('1', 64, '0'), '${INDEX_ID}', 'eligible', 'upsert', 1,
        ${revision("b000", "i")}, lpad('1', 64, '0'), '${INDEX_ID}',
        '2026-08-26', '2026-08-26', '2026-08-26'
      FROM ${series}
    `),
  );
  await db.execute(sql.raw("VACUUM ANALYZE corpus_index_projection_intents"));
  await db.execute(sql.raw("VACUUM ANALYZE corpus_index_projection_states"));
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await seedBacklog();
});

afterAll(async () => {
  await client.close();
});

/** The walk's own CTE and every node nested under it, by indentation. */
const nodeOf = (lines: readonly string[], cte: string): string => {
  const start = lines.findIndex((line) => line.includes(`CTE ${cte}`));
  if (start === -1) {
    return panic(`No ${cte} in plan:\n${lines.join("\n")}`);
  }
  const depth =
    (lines[start] ?? "").length - (lines[start] ?? "").trimStart().length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && line.length - line.trimStart().length <= depth,
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
};

// timeout: seeds 150,000 projection rows in PGlite before reading one plan.
test("the at-risk walk over 50,000 deletes beside applied replacements is a bounded index range", async () => {
  const explained = await db.execute(
    sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${corpusIndexFlipRegressionQuery(
      PAIR,
      Temporal.Instant.from("2026-08-01T00:00:00Z"),
    )}`,
  );
  const lines = planLines(explained);
  const scan = nodeOf(lines, "at_risk_scan");
  const walk = nodeOf(lines, "at_risk_walk");
  // The scan is an index range of the revisions being deleted, cut at its
  // cap, never a read of the table.
  expect(scan).toMatch(/Index Scan|Bitmap Index Scan/u);
  expect(scan).not.toContain("Seq Scan");
  expect(scan).toContain("Limit");
  expect(BACKLOG).toBeLessThan(CORPUS_INDEX_FLIP_AT_RISK_SCAN_CAP);
  // Each scanned revision costs one probe of its state's primary key, and
  // every one is left out: its state names the applied replacement.
  expect(walk).toContain("corpus_index_projection_states_pkey");
  expect(walk).toMatch(new RegExp(`loops=${String(BACKLOG)}`, "u"));
  expect(walk).not.toContain("Seq Scan");
  expect(walk).toMatch(
    /Unique \(actual time=[\d.]+\.\.[\d.]+ rows=0(?:\.00)? loops=1\)/u,
  );
  const executionMs = Number(
    /Execution Time: (?<ms>[\d.]+) ms/u.exec(lines.join("\n"))?.groups?.[
      "ms"
    ] ?? Number.NaN,
  );
  expect(Number.isFinite(executionMs)).toBe(true);
  // The statement budget a parity read runs under, with room for a slower
  // server: the embedded database is slower than PostgreSQL itself.
  expect(executionMs).toBeLessThan(20_000);
}, 300_000);
