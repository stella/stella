import { panic } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusProjectionReservationQueue } from "@/api/lib/legal-search/corpus-index-projection-store";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const INDEX_ID = "case_law_v5_cs_sk";
const GENERATION = "case_law_v5";
/** Converged entities: in the table, out of the pending queue. */
const CONVERGED = 2500;
/** Pending entities an in-flight lease already owns, oldest in the queue. */
const IN_FLIGHT = 100;
/** Pending entities whose every earlier revision has settled. */
const RESERVABLE = 400;
const LIMIT = 64;
const ELIGIBILITY_AT = new Date("2026-09-01T00:00:00.000Z");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterEach(async () => {
  await client.close();
});

const entity = (offset: string) =>
  `('00000000-0000-4000-8000-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;

/** Deterministic id of the `depth`-th settled revision of entity `offset`. */
const settledRevision = (offset: string, depth: string) =>
  `('00000000-0000-4000-a00' || to_hex(${depth}) || '-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;

/**
 * Append one settled revision per entity. Settled revisions are never deleted,
 * so this history is the term that grows without bound as a generation is
 * re-projected.
 */
const appendSettledHistory = async (depth: number): Promise<void> => {
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         append_publish_barrier_at, cleanup_not_before, cleanup_started_at,
         delete_opstamp, settled_at, created_at, updated_at)
      SELECT
        ${settledRevision("i", String(depth))},
        'case_law', '${GENERATION}', ${entity("i")}, ${depth},
        lpad(to_hex(i), 64, '0'), '${INDEX_ID}', 'settled', 3,
        '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz, 1, '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz, '2026-07-01'::timestamptz
      FROM generate_series(1, ${CONVERGED + IN_FLIGHT + RESERVABLE}) AS i
    `),
  );
  await db.execute(sql.raw("VACUUM ANALYZE corpus_index_projection_intents"));
};

const seed = async (historyDepth: number): Promise<void> => {
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
  for (let depth = 1; depth <= historyDepth; depth += 1) {
    await appendSettledHistory(depth);
  }
  const liveEpoch = historyDepth + 1;

  // Converged: the applied revision equals the desired one, so the pending
  // queue never sees these rows.
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         applied_at, created_at, updated_at)
      SELECT
        ('00000000-0000-4000-9000-' || lpad(to_hex(i), 12, '0'))::uuid,
        'case_law', '${GENERATION}', ${entity("i")}, ${liveEpoch},
        lpad(to_hex(i), 64, '0'), '${INDEX_ID}', 'applied', 3,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz
      FROM generate_series(1, ${CONVERGED}) AS i
    `),
  );
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, applied_action,
         applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
         applied_at, created_at, updated_at)
      SELECT
        'case_law', '${GENERATION}', ${entity("i")}, 'upsert', ${liveEpoch},
        lpad(to_hex(i), 64, '0'), '${INDEX_ID}', 'eligible', 'upsert',
        ${liveEpoch}, ('00000000-0000-4000-9000-' || lpad(to_hex(i), 12, '0'))::uuid,
        lpad(to_hex(i), 64, '0'), '${INDEX_ID}',
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz
      FROM generate_series(1, ${CONVERGED}) AS i
    `),
  );

  // In flight: pending, and an unexpired lease already owns the revision. The
  // lease is not a row lock, so every reservation walks these again.
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         lease_token, lease_expires_at, created_at, updated_at)
      SELECT
        ('00000000-0000-4000-c000-' || lpad(to_hex(i), 12, '0'))::uuid,
        'case_law', '${GENERATION}', ${entity(`i + ${CONVERGED}`)},
        ${liveEpoch}, lpad(to_hex(i), 64, 'a'), '${INDEX_ID}', 'reserved',
        gen_random_uuid(), '2026-09-02'::timestamptz,
        '2026-08-30'::timestamptz, '2026-08-30'::timestamptz
      FROM generate_series(1, ${IN_FLIGHT}) AS i
    `),
  );
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, created_at, updated_at)
      SELECT
        'case_law', '${GENERATION}', ${entity(`i + ${CONVERGED}`)}, 'upsert',
        ${liveEpoch}, lpad(to_hex(i), 64, 'a'), '${INDEX_ID}', 'eligible',
        '2026-08-01'::timestamptz,
        ('2026-08-10'::timestamptz + (i || ' seconds')::interval)
      FROM generate_series(1, ${IN_FLIGHT}) AS i
    `),
  );

  // Reservable: the desired epoch moved on and every earlier revision settled.
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, applied_action,
         applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
         applied_at, created_at, updated_at)
      SELECT
        'case_law', '${GENERATION}', ${entity(`i + ${CONVERGED + IN_FLIGHT}`)},
        'upsert', ${liveEpoch}, lpad(to_hex(i), 64, 'b'), '${INDEX_ID}',
        'eligible', 'upsert', ${historyDepth},
        ${settledRevision(`i + ${CONVERGED + IN_FLIGHT}`, String(historyDepth))},
        lpad(to_hex(i + ${CONVERGED + IN_FLIGHT}), 64, '0'), '${INDEX_ID}',
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        ('2026-08-20'::timestamptz + (i || ' seconds')::interval)
      FROM generate_series(1, ${RESERVABLE}) AS i
    `),
  );
  await db.execute(sql.raw("VACUUM ANALYZE corpus_index_projection_states"));
};

type ReservationPlan = {
  lines: string[];
  reservedRows: number;
  buffers: number;
};

const planText = ({ lines }: ReservationPlan): string => lines.join("\n");

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

/** The intents scan node and the detail lines PostgreSQL nests under it. */
const intentProbe = ({ lines }: ReservationPlan): string => {
  const start = lines.findIndex((line) =>
    line.includes("on corpus_index_projection_intents"),
  );
  if (start === -1) {
    return panic(`No intents scan in plan:\n${lines.join("\n")}`);
  }
  const depth = indentOf(lines[start] ?? "");
  const end = lines.findIndex(
    (line, index) => index > start && indentOf(line) <= depth,
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
};

const explainRows = (explained: unknown): unknown[] => {
  if (Array.isArray(explained)) {
    return explained;
  }
  if (isRecord(explained) && Array.isArray(explained["rows"])) {
    return explained["rows"];
  }
  return panic("EXPLAIN did not return plan rows");
};

const planLines = (explained: unknown): string[] =>
  explainRows(explained).map((row) => {
    const text = isRecord(row) ? row["QUERY PLAN"] : undefined;
    return typeof text === "string"
      ? text
      : panic("EXPLAIN row has no plan text");
  });

const explainReservation = async (): Promise<ReservationPlan> =>
  await db.transaction(async (transaction) => {
    const tx = asTestRaw<Transaction>(transaction);
    // A generation this small lets the planner hash the whole outstanding set
    // instead of probing it. Production reserves against a set too large for
    // that, so the guard pins the join to the shape that runs there and
    // measures what one probe costs.
    await tx.execute(sql`SET LOCAL enable_hashjoin = off`);
    await tx.execute(sql`SET LOCAL enable_mergejoin = off`);
    await tx.execute(sql`SET LOCAL enable_material = off`);
    const queue = corpusProjectionReservationQueue(tx, {
      family: "case_law",
      generation: GENERATION,
      limit: LIMIT,
      eligibilityAt: ELIGIBILITY_AT,
      scopedEntityIds: null,
      scopedIndexId: null,
    });
    const lines = planLines(
      await tx.execute(
        sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${queue.getSQL()}`,
      ),
    );
    const plan = lines.join("\n");
    const reservedRows = Number(
      /^Limit .*rows=(\d+)/mu.exec(plan)?.[1] ?? Number.NaN,
    );
    const topBuffers = /^\s*Buffers: shared hit=(\d+)(?: read=(\d+))?/mu.exec(
      plan,
    );
    const buffers =
      Number(topBuffers?.[1] ?? Number.NaN) + Number(topBuffers?.[2] ?? 0);
    if (!Number.isFinite(reservedRows) || !Number.isFinite(buffers)) {
      return panic(`EXPLAIN output is not measurable:\n${plan}`);
    }
    return { lines, reservedRows, buffers };
  });

test("the reservation queue reads outstanding revisions, not revision history", async () => {
  await seed(2);
  const shallow = await explainReservation();
  expect(shallow.reservedRows).toBe(LIMIT);
  expect(planText(shallow)).not.toContain("Seq Scan");
  // The partial index answers the anti-join, so the probe never inspects,
  // and never fetches the heap for, a quiescent revision.
  expect(intentProbe(shallow)).toContain(
    "corpus_index_projection_intents_outstanding_idx",
  );
  expect(intentProbe(shallow)).not.toContain("Rows Removed by Filter");

  for (let depth = 3; depth <= 12; depth += 1) {
    await appendSettledHistory(depth);
  }
  const deep = await explainReservation();
  expect(deep.reservedRows).toBe(LIMIT);
  expect(planText(deep)).not.toContain("Seq Scan");
  expect(intentProbe(deep)).toContain(
    "corpus_index_projection_intents_outstanding_idx",
  );
  expect(intentProbe(deep)).not.toContain("Rows Removed by Filter");

  // Six times the settled history must not cost measurably more to skip.
  expect(deep.buffers).toBeLessThanOrEqual(Math.round(shallow.buffers * 1.25));
  // What remains is the in-flight prefix ahead of the reserved batch, not
  // anything either table accumulates.
  expect(deep.buffers / deep.reservedRows).toBeLessThanOrEqual(25);
}, 600_000);
