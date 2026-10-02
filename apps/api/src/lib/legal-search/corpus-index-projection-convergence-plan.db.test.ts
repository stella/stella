/**
 * The convergence probes run under the exclusive projection mutation fence,
 * so every projection writer waits on them. Each one must read a bounded
 * index range of its generation, never the projection tables, and above all
 * when it finds nothing: a converged generation is the common case. The plans
 * are checked under the fixture's statistics and again with both tables
 * scaled to the synthetic profile, each time as a custom and as a generic
 * plan, and the probes also run against the fixture for their answers.
 */

import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_LAUNCH_BLOCKING_INTENT_STATUSES } from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  corpusProjectionOutstandingIntentProbe,
  corpusProjectionStateQueueProbe,
  corpusProjectionUnpublishedIntentProbe,
  readCorpusIndexProjectionConvergenceTx,
} from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";
import type { ScanOccurrence } from "@/api/tests/query-plans/plan-walker";
import {
  scaleTableToProfile,
  SYNTHETIC_SCALE_PROFILE,
} from "@/api/tests/query-plans/scale-profile";

const DB_TEST_TIMEOUT_MS = 300_000;
const STATES = "corpus_index_projection_states";
const INTENTS = "corpus_index_projection_intents";
const PROJECTION_TABLES: ReadonlySet<string> = new Set([STATES, INTENTS]);

/** Converged: every state applied, every revision applied or settled. */
const QUIET = { family: "case_law", generation: "case_law_v5" } as const;
const QUIET_INDEX_ID = "case_law_v5_cs_sk";
/** Another generation with work queued, so the partial indexes are not empty. */
const BUSY = { family: "legislation", generation: "legislation_v2" } as const;
const BUSY_INDEX_ID = "legislation_v2_cs";

const CONVERGED = 3000;
const PENDING = 400;
const BLOCKED = 50;
const CLEANUP = 200;

const PLAN_MODES = ["force_custom_plan", "force_generic_plan"] as const;
type PlanMode = (typeof PLAN_MODES)[number];

let client: PGlite;
let db: ReturnType<typeof drizzle>;

const entity = (prefix: string, offset: string) =>
  `('00000000-0000-4000-${prefix}-' || lpad(to_hex(${offset}), 12, '0'))::uuid`;

const seed = async () => {
  await db.insert(corpusIndexGenerations).values([
    {
      ...QUIET,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.case_law_v5,
      ),
      status: "building",
    },
    {
      ...BUSY,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.legislation_v2,
      ),
      status: "building",
    },
  ]);
  // Settled history: the revisions a re-projected generation accumulates.
  await db.execute(
    sql.raw(`
      INSERT INTO ${INTENTS}
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         append_publish_barrier_at, cleanup_not_before, cleanup_started_at,
         delete_opstamp, delete_task_created_at, settled_at, created_at,
         updated_at)
      SELECT
        ${entity("a000", "i")}, '${QUIET.family}', '${QUIET.generation}',
        ${entity("8000", "i")}, 1, lpad(to_hex(i), 64, 'b'), '${QUIET_INDEX_ID}',
        'settled', 3, '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz, 1, '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz, '2026-07-01'::timestamptz,
        '2026-07-01'::timestamptz
      FROM generate_series(1, ${CONVERGED}) AS i
    `),
  );
  // Applied long ago, so the engine has certainly published them.
  await db.execute(
    sql.raw(`
      INSERT INTO ${INTENTS}
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         applied_at, created_at, updated_at)
      SELECT
        ${entity("9000", "i")}, '${QUIET.family}', '${QUIET.generation}',
        ${entity("8000", "i")}, 2, lpad(to_hex(i), 64, '0'), '${QUIET_INDEX_ID}',
        'applied', 3, '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz
      FROM generate_series(1, ${CONVERGED}) AS i
    `),
  );
  await db.execute(
    sql.raw(`
      INSERT INTO ${STATES}
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, applied_action,
         applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
         applied_at, created_at, updated_at)
      SELECT
        '${QUIET.family}', '${QUIET.generation}', ${entity("8000", "i")},
        'upsert', 2, lpad(to_hex(i), 64, '0'), '${QUIET_INDEX_ID}', 'eligible',
        'upsert', 2, ${entity("9000", "i")}, lpad(to_hex(i), 64, '0'),
        '${QUIET_INDEX_ID}', '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz
      FROM generate_series(1, ${CONVERGED}) AS i
    `),
  );
  // The busy generation: never applied, so all of it needs work.
  await db.execute(
    sql.raw(`
      INSERT INTO ${STATES}
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, created_at,
         updated_at)
      SELECT
        '${BUSY.family}', '${BUSY.generation}', ${entity("b000", "i")},
        'upsert', 2, lpad(to_hex(i), 64, 'c'), '${BUSY_INDEX_ID}', 'eligible',
        '2026-09-01'::timestamptz,
        '2026-09-01'::timestamptz + (i || ' seconds')::interval
      FROM generate_series(1, ${PENDING}) AS i
    `),
  );
  await db.execute(
    sql.raw(`
      INSERT INTO ${STATES}
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, failure_attempts,
         last_failure_kind, last_failure_message, created_at, updated_at)
      SELECT
        '${BUSY.family}', '${BUSY.generation}',
        ${entity("b000", `i + ${PENDING}`)}, 'upsert', 1,
        lpad(to_hex(i), 64, 'd'), '${BUSY_INDEX_ID}', 'blocked', 1,
        'payload_unavailable', 'fixture payload is unavailable',
        '2026-09-01'::timestamptz, '2026-09-01'::timestamptz
      FROM generate_series(1, ${BLOCKED}) AS i
    `),
  );
  // Blocking revisions of the busy generation: the pending epochs leased, and
  // an earlier attempt of some of them cleaning up.
  await db.execute(
    sql.raw(`
      INSERT INTO ${INTENTS}
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         lease_token, lease_expires_at, created_at, updated_at)
      SELECT
        ${entity("c000", "i")}, '${BUSY.family}', '${BUSY.generation}',
        ${entity("b000", "i")}, 2, lpad(to_hex(i), 64, 'c'), '${BUSY_INDEX_ID}',
        'reserved', gen_random_uuid(), '2026-09-02'::timestamptz,
        '2026-09-01'::timestamptz, '2026-09-01'::timestamptz
      FROM generate_series(1, ${PENDING}) AS i
    `),
  );
  await db.execute(
    sql.raw(`
      INSERT INTO ${INTENTS}
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         append_started_at, append_publish_barrier_at, cleanup_not_before,
         created_at, updated_at)
      SELECT
        ${entity("d000", "i")}, '${BUSY.family}', '${BUSY.generation}',
        ${entity("b000", "i")}, 1, lpad(to_hex(i), 64, 'e'), '${BUSY_INDEX_ID}',
        'cleanup_pending', '2026-08-30'::timestamptz,
        '2026-08-30'::timestamptz, '2026-08-30'::timestamptz,
        '2026-08-30'::timestamptz, '2026-08-30'::timestamptz
      FROM generate_series(1, ${CLEANUP}) AS i
    `),
  );
  await db.execute(sql.raw(`VACUUM ANALYZE ${STATES}`));
  await db.execute(sql.raw(`VACUUM ANALYZE ${INTENTS}`));
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await seed();
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const sqlLiteral = (value: unknown): string => {
  if (typeof value === "string") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return panic(`Unexpected probe parameter: ${String(value)}`);
};

/**
 * The projection-table scans of `query`, prepared and explained under one
 * plan cache mode. A generic plan is chosen once without the parameters'
 * values, which is how a pooled prepared statement can end up running it.
 */
const probeScans = async (
  query: SQLWrapper,
  mode: PlanMode,
): Promise<ScanOccurrence[]> => {
  const { sql: text, params } = new PgDialect().sqlToQuery(query.getSQL());
  const values = params.map(sqlLiteral);
  await client.exec(`SET plan_cache_mode = ${mode}`);
  await client.exec(`PREPARE convergence_probe AS ${text}`);
  try {
    const explained = await client.query(
      `EXPLAIN (FORMAT JSON) EXECUTE convergence_probe${values.length > 0 ? `(${values.join(", ")})` : ""}`,
    );
    return scanOccurrences(explainRoot(explained)).filter(({ relation }) =>
      PROJECTION_TABLES.has(relation),
    );
  } finally {
    await client.exec("DEALLOCATE convergence_probe");
    await client.exec("RESET plan_cache_mode");
  }
};

const PROBES = {
  stateQueue: () => corpusProjectionStateQueueProbe(QUIET),
  outstandingIntent: () => corpusProjectionOutstandingIntentProbe(QUIET),
  unpublishedIntent: () =>
    corpusProjectionUnpublishedIntentProbe(
      QUIET,
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
} as const satisfies Record<string, () => SQLWrapper>;

type ProbePlans = Record<keyof typeof PROBES, ScanOccurrence[]>;

const planProbes = async (mode: PlanMode): Promise<ProbePlans> => ({
  stateQueue: await probeScans(PROBES.stateQueue(), mode),
  outstandingIntent: await probeScans(PROBES.outstandingIntent(), mode),
  unpublishedIntent: await probeScans(PROBES.unpublishedIntent(), mode),
});

const INDEX_PATHS: ReadonlySet<string> = new Set([
  "Index Scan",
  "Index Only Scan",
]);

/** Every projection scan is an index range of the probed generation. */
const expectGenerationRanges = (scans: readonly ScanOccurrence[]) => {
  expect(scans.length).toBeGreaterThan(0);
  for (const scan of scans) {
    expect({
      relation: scan.relation,
      indexPath: INDEX_PATHS.has(scan.nodeType),
      generationBound: (scan.indexCond ?? "").includes("generation"),
    }).toEqual({
      relation: scan.relation,
      indexPath: true,
      generationBound: true,
    });
  }
};

/** A first-row probe: one index read in index order that a Limit stops. */
const expectFirstRow = (scan: ScanOccurrence, index: string) => {
  expect({ index: scan.index, limitAbove: scan.limitAbove }).toEqual({
    index,
    limitAbove: true,
  });
};

const expectIndexedProbes = async () => {
  for (const mode of PLAN_MODES) {
    const plans = await planProbes(mode);
    for (const scans of Object.values(plans)) {
      expectGenerationRanges(scans);
    }

    const [hasState, hasBlocked, hasPending, ...extraStates] = plans.stateQueue;
    expect(extraStates).toEqual([]);
    expectFirstRow(
      hasState ?? panic("no state scan"),
      "corpus_index_projection_states_pkey",
    );
    expectFirstRow(
      hasBlocked ?? panic("no blocked scan"),
      "corpus_index_projection_states_blocked_idx",
    );
    expectFirstRow(
      hasPending ?? panic("no pending scan"),
      "corpus_index_projection_states_pending_idx",
    );

    // One probe per blocking status, then the applied revisions and the
    // states that reference them. Several intent indexes lead with the
    // generation and status, so the planner may pick any of them; each is
    // still a range of this generation, which is what the check requires.
    expect(plans.outstandingIntent.map(({ relation }) => relation)).toEqual([
      ...CORPUS_INDEX_LAUNCH_BLOCKING_INTENT_STATUSES.map(() => INTENTS),
      INTENTS,
      STATES,
    ]);
    expect(plans.unpublishedIntent.map(({ relation }) => relation)).toEqual([
      INTENTS,
    ]);
  }
};

test(
  "the probes answer from the fixture",
  async () => {
    const read = async (target: typeof QUIET | typeof BUSY) =>
      await db.transaction(
        async (tx) =>
          await readCorpusIndexProjectionConvergenceTx(
            asTestRaw<Transaction>(tx),
            target,
          ),
      );
    expect(await read(QUIET)).toBe("ready_for_census");
    expect(await read(BUSY)).toBe("pending");
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "every probe reads index ranges of its generation, and still does at scale",
  async () => {
    await expectIndexedProbes();
    await scaleTableToProfile(db, STATES, SYNTHETIC_SCALE_PROFILE);
    await scaleTableToProfile(db, INTENTS, SYNTHETIC_SCALE_PROFILE);
    await expectIndexedProbes();
  },
  DB_TEST_TIMEOUT_MS,
);
