import { panic } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusProjectionCleanupClaimPage } from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { caseLawWaitingReplacementsQuery } from "@/api/lib/observability/case-law-freshness-metrics";
import { planLines } from "@/api/tests/helpers/explain-plan";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const INDEX_ID = "case_law_v5_cs_sk";
const GENERATION = "case_law_v5";
/** Converged entities: served, nothing queued. */
const CONVERGED = 2000;
/** Unserved revisions queued for cleanup after the served backlog. */
const UNSERVED = 200;
const LIMIT = 64;

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

const entity = (offset: string) =>
  `('00000000-0000-4000-8000-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;
const revision = (prefix: string, offset: string) =>
  `('00000000-0000-4000-${prefix}-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;

/**
 * Entities served by an applied revision. With `waiting`, their desired epoch
 * has moved on: a replacement waiting, served at the old revision. With
 * `queuedAt`, the served revision was queued for cleanup at that instant, as
 * an earlier release's replacement preparation left it.
 */
const seedServed = async ({
  first,
  count,
  waiting,
  queuedAt,
}: {
  first: number;
  count: number;
  waiting: boolean;
  queuedAt: string | null;
}) => {
  const last = first + count - 1;
  const status = queuedAt === null ? "'applied'" : "'cleanup_pending'";
  const barrier =
    queuedAt === null ? "NULL::timestamptz" : "'2026-07-01'::timestamptz";
  const queued =
    queuedAt === null
      ? "NULL::timestamptz"
      : `'${queuedAt}'::timestamptz + (i || ' seconds')::interval`;
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         applied_at, append_publish_barrier_at, cleanup_not_before,
         created_at, updated_at)
      SELECT ${revision("9000", "i")}, 'case_law', '${GENERATION}',
        ${entity("i")}, 1, lpad(to_hex(i), 64, '0'), '${INDEX_ID}', ${status},
        3, '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz,
        ${barrier}, ${queued},
        '2026-07-01'::timestamptz, '2026-07-01'::timestamptz
      FROM generate_series(${first}, ${last}) AS i
    `),
  );
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, applied_action,
         applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
         applied_at, created_at, updated_at)
      SELECT 'case_law', '${GENERATION}', ${entity("i")}, 'upsert',
        ${waiting ? 2 : 1}, lpad(to_hex(i), 64, '${waiting ? "d" : "0"}'),
        '${INDEX_ID}', 'eligible', 'upsert', 1, ${revision("9000", "i")},
        lpad(to_hex(i), 64, '0'), '${INDEX_ID}', '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz,
        ('2026-07-15'::timestamptz + (i || ' seconds')::interval)
      FROM generate_series(${first}, ${last}) AS i
    `),
  );
};

/** Revisions queued for cleanup that no state names. */
const seedUnserved = async (first: number, count: number) => {
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         append_started_at, append_publish_barrier_at, cleanup_not_before,
         last_error, created_at, updated_at)
      SELECT ${revision("e000", "i")}, 'case_law', '${GENERATION}',
        ${entity("i")}, 1, lpad(to_hex(i), 64, 'e'), '${INDEX_ID}',
        'cleanup_pending', '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz,
        ('2026-08-01'::timestamptz + (i || ' seconds')::interval),
        'projection append lease expired with unknown outcome',
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz
      FROM generate_series(${first}, ${first + count - 1}) AS i
    `),
  );
};

const analyze = async () => {
  await db.execute(sql.raw("VACUUM ANALYZE corpus_index_projection_intents"));
  await db.execute(sql.raw("VACUUM ANALYZE corpus_index_projection_states"));
};

type Plan = { lines: string[]; rows: number; buffers: number };

const explain = async (query: (tx: Transaction) => SQL): Promise<Plan> =>
  await db.transaction(async (transaction) => {
    const tx = asTestRaw<Transaction>(transaction);
    // A table this small lets the planner hash or sort where production,
    // with millions of rows, walks the index; pin the production shape.
    await tx.execute(sql`SET LOCAL enable_hashjoin = off`);
    await tx.execute(sql`SET LOCAL enable_mergejoin = off`);
    await tx.execute(sql`SET LOCAL enable_material = off`);
    await tx.execute(sql`SET LOCAL enable_sort = off`);
    const lines = planLines(
      await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${query(tx)}`),
    );
    const plan = lines.join("\n");
    const rows = Number(/actual (?:time=\S+ )?rows=(\d+)/u.exec(plan)?.[1]);
    const topBuffers = /^\s*Buffers: shared hit=(\d+)(?: read=(\d+))?/mu.exec(
      plan,
    );
    const buffers =
      Number(topBuffers?.[1] ?? Number.NaN) + Number(topBuffers?.[2] ?? 0);
    if (!Number.isFinite(rows) || !Number.isFinite(buffers)) {
      return panic(`EXPLAIN output is not measurable:\n${plan}`);
    }
    return { lines, rows, buffers };
  });

const claimPage = (tx: Transaction) =>
  corpusProjectionCleanupClaimPage(tx, {
    family: "case_law",
    generation: GENERATION,
    indexId: INDEX_ID,
    limit: LIMIT,
    scopedEntityIds: null,
  }).getSQL();

// timeout: seeds and vacuums thousands of rows in PGlite, with no signal to await.
test("the cleanup claim reads one page of its queue, however many served revisions head it", async () => {
  await seedServed({
    first: 1,
    count: CONVERGED,
    waiting: false,
    queuedAt: null,
  });
  const BACKLOG = 500;
  await seedServed({
    first: CONVERGED + 1,
    count: BACKLOG,
    waiting: true,
    queuedAt: "2026-07-10",
  });
  await seedUnserved(CONVERGED + 10 * BACKLOG + 1, UNSERVED);
  await analyze();
  const small = await explain(claimPage);
  const text = small.lines.join("\n");
  expect(small.rows).toBe(LIMIT);
  expect(text).not.toContain("Seq Scan");
  // The queue is walked in its order off an index on the status and the
  // not-before instant, and reads one row past the page.
  const queueScan =
    /Index Scan using corpus_index_projection_intents_(?:cleanup_claim|work)_idx on corpus_index_projection_intents \(actual [^)]*rows=(\d+)/u.exec(
      text,
    );
  expect(Number(queueScan?.[1])).toBeLessThanOrEqual(LIMIT + 1);
  // Whether a revision is served is one probe of the unique pointer index.
  expect(text).toContain(
    "corpus_index_projection_states_applied_revision_uidx",
  );

  // Ten times the served backlog ahead of the queue costs the page nothing:
  // the claim restores or claims every row it reads, so the next turn
  // starts past them.
  await seedServed({
    first: CONVERGED + BACKLOG + 1,
    count: 9 * BACKLOG,
    waiting: true,
    queuedAt: "2026-07-05",
  });
  await analyze();
  const large = await explain(claimPage);
  expect(large.rows).toBe(LIMIT);
  expect(large.buffers).toBeLessThanOrEqual(Math.round(small.buffers * 1.25));
  expect(large.buffers / large.rows).toBeLessThanOrEqual(25);
}, 600_000);

// timeout: seeds and vacuums thousands of rows in PGlite, with no signal to await.
test("the waiting-replacement gauge walks only the replacement index", async () => {
  await seedServed({
    first: 1,
    count: CONVERGED,
    waiting: false,
    queuedAt: null,
  });
  await seedServed({
    first: CONVERGED + 1,
    count: 300,
    waiting: true,
    queuedAt: null,
  });
  await analyze();
  const gauge = await explain(() =>
    caseLawWaitingReplacementsQuery(GENERATION),
  );
  const text = gauge.lines.join("\n");
  expect(text).not.toContain("Seq Scan");
  expect(text).toContain(
    "corpus_index_projection_states_replacement_route_idx",
  );
  expect(text).not.toContain("corpus_index_projection_states_pkey");
  const counted = await db.execute<{ index_id: string; count: number }>(
    caseLawWaitingReplacementsQuery(GENERATION),
  );
  expect(counted.rows).toEqual([
    expect.objectContaining({ index_id: INDEX_ID, count: 300 }),
  ]);
}, 600_000);
