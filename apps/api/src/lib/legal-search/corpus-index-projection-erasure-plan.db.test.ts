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
import { corpusProjectionErasureClaimQuery } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { planLines } from "@/api/tests/helpers/explain-plan";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const INDEX_ID = "case_law_v5_cs_sk";
/** The generation that owes erasures. */
const ERASING = "case_law_v5";
/** A generation of the same size with no erasure outstanding. */
const QUIET = "case_law_v6";
/** Entities converged or in flight for an append: never claimed by erasure. */
const APPEND_ENTITIES = 4000;
/** Erasures already applied at the desired epoch: out of the claim. */
const APPLIED_ERASURES = 1000;
/** Erasures still owed, half never applied and half applied at an older epoch. */
const PENDING_ERASURES = 400;
const LIMIT = 64;

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

/** Distinct queue positions, so the claim's order is deterministic. */
const updatedAt = (offset: string) =>
  `('2026-08-20'::timestamptz + (${offset} || ' seconds')::interval)`;

const seedGeneration = async (
  generation: string,
  pendingErasures: number,
): Promise<void> => {
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
  // The append population. It dwarfs the erasures and shares every column the
  // claim filters on except the desired action.
  await db.execute(
    sql.raw(`
    INSERT INTO corpus_index_projection_states
      (family, generation, entity_id, desired_action, desired_epoch,
       desired_fingerprint, desired_index_id, work_status, created_at, updated_at)
    SELECT
      'case_law', '${generation}', ${entity("i")}, 'upsert', 1,
      lpad(to_hex(i), 64, '0'), '${INDEX_ID}', 'eligible',
      '2026-08-01'::timestamptz, ${updatedAt("i")}
    FROM generate_series(1, ${APPEND_ENTITIES}) AS i
  `),
  );
  // Erasures the projection already applied at the desired epoch. They keep
  // the erased desired action for as long as the generation lives, so only
  // the applied half of the predicate separates them from the claim.
  await db.execute(
    sql.raw(`
    INSERT INTO corpus_index_projection_states
      (family, generation, entity_id, desired_action, desired_epoch,
       work_status, applied_action, applied_epoch, applied_at, created_at,
       updated_at)
    SELECT
      'case_law', '${generation}', ${entity(`i + ${APPEND_ENTITIES}`)},
      'erase', 2, 'eligible', 'erase', 2, '2026-08-15'::timestamptz,
      '2026-08-01'::timestamptz, ${updatedAt(`i + ${APPEND_ENTITIES}`)}
    FROM generate_series(1, ${APPLIED_ERASURES}) AS i
  `),
  );
  if (pendingErasures === 0) {
    await db.execute(sql.raw("VACUUM ANALYZE corpus_index_projection_states"));
    return;
  }
  const neverApplied = Math.ceil(pendingErasures / 2);
  const offset = APPEND_ENTITIES + APPLIED_ERASURES;
  // Owed, and nothing applied yet.
  await db.execute(
    sql.raw(`
    INSERT INTO corpus_index_projection_states
      (family, generation, entity_id, desired_action, desired_epoch,
       work_status, created_at, updated_at)
    SELECT
      'case_law', '${generation}', ${entity(`i + ${offset}`)}, 'erase', 2,
      'eligible', '2026-08-01'::timestamptz, ${updatedAt(`i + ${offset}`)}
    FROM generate_series(1, ${neverApplied}) AS i
  `),
  );
  // Owed again: erased once, then the entity came back and was erased at a
  // later epoch. Only the epoch half of the predicate keeps these in.
  await db.execute(
    sql.raw(`
    INSERT INTO corpus_index_projection_states
      (family, generation, entity_id, desired_action, desired_epoch,
       work_status, applied_action, applied_epoch, applied_at, created_at,
       updated_at)
    SELECT
      'case_law', '${generation}',
      ${entity(`i + ${offset + neverApplied}`)}, 'erase', 3, 'eligible',
      'erase', 2, '2026-08-15'::timestamptz, '2026-08-01'::timestamptz,
      ${updatedAt(`i + ${offset + neverApplied}`)}
    FROM generate_series(1, ${pendingErasures - neverApplied}) AS i
  `),
  );
  await db.execute(sql.raw("VACUUM ANALYZE corpus_index_projection_states"));
};

type ClaimPlan = {
  buffers: number;
  claimedRows: number;
  plan: string;
};

const explainClaim = async (generation: string): Promise<ClaimPlan> =>
  await db.transaction(async (transaction) => {
    const tx = asTestRaw<Transaction>(transaction);
    const claim = corpusProjectionErasureClaimQuery(tx, {
      family: "case_law",
      generation,
      limit: LIMIT,
      scopedEntityIds: null,
    });
    const plan = planLines(
      await tx.execute(
        sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${claim.getSQL()}`,
      ),
    ).join("\n");
    const claimedRows = Number(
      /^Limit .*rows=(\d+)/mu.exec(plan)?.[1] ?? Number.NaN,
    );
    const topBuffers = /^\s*Buffers: shared hit=(\d+)(?: read=(\d+))?/mu.exec(
      plan,
    );
    const buffers =
      Number(topBuffers?.[1] ?? Number.NaN) + Number(topBuffers?.[2] ?? 0);
    if (!Number.isFinite(claimedRows) || !Number.isFinite(buffers)) {
      return panic(`EXPLAIN output is not measurable:\n${plan}`);
    }
    return { buffers, claimedRows, plan };
  });

test("the erasure claim reads pending erasures, not the projection table", async () => {
  await seedGeneration(ERASING, PENDING_ERASURES);
  await seedGeneration(QUIET, 0);

  const owed = await explainClaim(ERASING);
  expect(owed.claimedRows).toBe(LIMIT);
  expect(owed.plan).not.toContain("Seq Scan");
  expect(owed.plan).toContain(
    "corpus_index_projection_states_erase_pending_idx",
  );
  // The scan stops at the batch instead of sorting the generation, and every
  // row it reads is one the claim wants. The predicate stays on the node as a
  // recheck because the claim locks its rows; it removes nothing.
  expect(owed.plan).not.toContain("Rows Removed by Filter");
  expect(owed.plan).not.toContain("Sort");

  // A generation with nothing pending is the common case: every cycle of
  // every generation runs this claim. It must cost a probe, not a table.
  const quiet = await explainClaim(QUIET);
  expect(quiet.claimedRows).toBe(0);
  expect(quiet.plan).not.toContain("Seq Scan");
  expect(quiet.plan).toContain(
    "corpus_index_projection_states_erase_pending_idx",
  );
  expect(quiet.buffers).toBeLessThanOrEqual(owed.buffers);
  expect(quiet.buffers).toBeLessThanOrEqual(20);
}, 600_000);

test("the erasure claim writes its desired action as a literal", async () => {
  const { params, sql: text } = corpusProjectionErasureClaimQuery(
    asTestRaw<Transaction>(db),
    {
      family: "case_law",
      generation: ERASING,
      limit: LIMIT,
      scopedEntityIds: null,
    },
  ).toSQL();

  // A bound action would leave the planner nothing to prove the partial
  // index's predicate from once the statement plans generically, and the
  // claim would fall back to reading the table.
  expect(text).toContain("'erase'");
  expect(params).not.toContain("erase");
});
