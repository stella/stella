import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusProjectionUnservedCountQuery,
  readCorpusProjectionUnservedCountsTx,
} from "@/api/lib/legal-search/corpus-index-projection-unserved";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import unservedIndexes from "./online-migration-entries/indexes-corpus-projection-unserved-gauge";

const MIGRATION = "20261115000000_corpus_projection_unserved_indexes";
const TARGET = { family: "case_law", generation: "case_law_v5" } as const;
const INDEX_ID = "case_law_v5_cs_sk";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
});

afterAll(async () => {
  await client.close();
});

const run = async (statement: string): Promise<void> => {
  await client.query(statement);
};

type SeededRevision =
  | { type: "none" }
  | {
      type: "named";
      /** Status-specific columns, written as the previous release writes them. */
      status: string;
      cleanupAttempts: number;
    };

/**
 * One state per serving branch, written before the migration with the columns
 * the previous release writes; the gauge reads nothing it does not.
 */
const SEEDS = [
  {
    name: "never applied",
    desired: "upsert",
    applied: "none",
    revision: { type: "none" },
    unserved: null,
  },
  {
    name: "applied and current",
    desired: "upsert",
    applied: "upsert",
    revision: { type: "named", status: "applied", cleanupAttempts: 0 },
    unserved: null,
  },
  {
    name: "queued for cleanup, no delete issued",
    desired: "upsert",
    applied: "upsert",
    revision: { type: "named", status: "cleanup_pending", cleanupAttempts: 0 },
    unserved: null,
  },
  {
    name: "claimed for a delete",
    desired: "upsert",
    applied: "upsert",
    revision: { type: "named", status: "cleanup_started", cleanupAttempts: 1 },
    unserved: "at_risk",
  },
  {
    name: "delete committed",
    desired: "upsert",
    applied: "upsert",
    revision: {
      type: "named",
      status: "cleanup_committed",
      cleanupAttempts: 1,
    },
    unserved: "at_risk",
  },
  {
    name: "delete stalled",
    desired: "upsert",
    applied: "upsert",
    revision: { type: "named", status: "cleanup_stalled", cleanupAttempts: 2 },
    unserved: "at_risk",
  },
  {
    name: "sent back after a claim",
    desired: "upsert",
    applied: "upsert",
    revision: { type: "named", status: "cleanup_pending", cleanupAttempts: 1 },
    unserved: "at_risk",
  },
  {
    name: "delete settled",
    desired: "upsert",
    applied: "upsert",
    revision: { type: "named", status: "settled", cleanupAttempts: 1 },
    unserved: "absent",
  },
  {
    name: "erasure applied, upsert wanted again",
    desired: "upsert",
    applied: "erase",
    revision: { type: "none" },
    unserved: "absent",
  },
  {
    name: "erasure wanted while a delete is committed",
    desired: "erase",
    applied: "upsert",
    revision: {
      type: "named",
      status: "cleanup_committed",
      cleanupAttempts: 1,
    },
    unserved: null,
  },
] as const satisfies readonly {
  name: string;
  desired: "upsert" | "erase";
  applied: "none" | "upsert" | "erase";
  revision: SeededRevision;
  unserved: "at_risk" | "absent" | null;
}[];

const T = "'2026-07-01T00:00:00Z'::timestamptz";

/** Columns each status's shape check requires, beyond the append's own. */
const STATUS_COLUMNS = {
  applied: "",
  cleanup_pending: `, cleanup_not_before = '2026-07-01T00:00:00Z'`,
  cleanup_started: `, cleanup_not_before = '2026-07-01T00:00:00Z', cleanup_started_at = '2026-07-01T00:00:00Z'`,
  cleanup_committed: `, cleanup_not_before = '2026-07-01T00:00:00Z', cleanup_started_at = '2026-07-01T00:00:00Z',
    delete_opstamp = 1, delete_task_created_at = '2026-07-01T00:00:00Z'`,
  cleanup_stalled: `, cleanup_not_before = '2026-07-01T00:00:00Z', cleanup_started_at = '2026-07-01T00:00:00Z',
    delete_opstamp = 1, delete_task_created_at = '2026-07-01T00:00:00Z'`,
  settled: `, cleanup_not_before = '2026-07-01T00:00:00Z', cleanup_started_at = '2026-07-01T00:00:00Z',
    delete_opstamp = 1, delete_task_created_at = '2026-07-01T00:00:00Z', settled_at = '2026-07-01T00:00:00Z'`,
} as const;

const seed = async (): Promise<void> => {
  for (const [offset, { desired, applied, revision }] of SEEDS.entries()) {
    const entity = `00000000-0000-4000-8000-${String(offset + 1).padStart(12, "0")}`;
    const revisionId = `00000000-0000-4000-9000-${String(offset + 1).padStart(12, "0")}`;
    const named = revision.type === "named";
    if (named) {
      // db-await-in-loop: one fixed row per seeded class
      await run(`
        INSERT INTO corpus_index_projection_intents
          (id, family, generation, entity_id, epoch, fingerprint, index_id,
           status, expected_document_count, append_started_at,
           append_committed_at, append_publish_barrier_at, applied_at,
           created_at, updated_at)
        VALUES
          ('${revisionId}', '${TARGET.family}', '${TARGET.generation}', '${entity}', 1,
           lpad('1', 64, '0'), '${INDEX_ID}', 'applied', 3, ${T}, ${T}, ${T}, ${T}, ${T}, ${T})
      `);
    }
    // db-await-in-loop: one fixed row per seeded class
    await run(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, applied_action, applied_epoch,
         applied_revision, applied_fingerprint, applied_index_id, applied_at,
         created_at, updated_at)
      VALUES
        ('${TARGET.family}', '${TARGET.generation}', '${entity}', '${desired}', 2,
         ${desired === "upsert" ? "lpad('2', 64, '0')" : "NULL"},
         ${desired === "upsert" ? `'${INDEX_ID}'` : "NULL"},
         ${applied === "none" ? "NULL" : `'${applied}'`},
         ${applied === "none" ? "NULL" : "1"},
         ${named ? `'${revisionId}'` : "NULL"},
         ${applied === "upsert" ? "lpad('1', 64, '0')" : "NULL"},
         ${applied === "upsert" ? `'${INDEX_ID}'` : "NULL"},
         ${applied === "none" ? "NULL" : T}, ${T}, ${T})
    `);
    if (named) {
      // The named revision moves on after the state names it, as cleanup
      // moves it, so the settled trigger sees the transition.
      // db-await-in-loop: one fixed row per seeded class
      await run(`
        UPDATE corpus_index_projection_intents
        SET status = '${revision.status}',
            cleanup_attempts = ${revision.cleanupAttempts}
            ${STATUS_COLUMNS[revision.status]}
        WHERE id = '${revisionId}'
      `);
    }
  }
};

test("the migration's indexes, built online over rows of every class, count exactly the unserved ones", async () => {
  for (const { name } of unservedIndexes.values) {
    // db-await-in-loop: the entry's two indexes
    await run(`DROP INDEX "${name}"`);
  }
  await seed();
  const migration = readFileSync(
    nodePath.resolve(
      import.meta.dir,
      `../../drizzle/${MIGRATION}/migration.sql`,
    ),
    "utf-8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    // db-await-in-loop: the migration's statements, in order
    await run(statement);
  }
  for (const {
    name,
    introducedBy,
    createSql,
    definitionBody,
  } of unservedIndexes.values) {
    expect(introducedBy).toBe(MIGRATION);
    // db-await-in-loop: the entry's two indexes, built as the online phase builds them
    await run(createSql);
    const { rows } = await client.query<{ definition: string }>(
      "SELECT pg_get_indexdef($1::regclass) AS definition",
      [name],
    );
    expect(rows.at(0)?.definition).toBe(
      `CREATE INDEX ${name} ${definitionBody}`,
    );
  }

  const counts = await db.transaction(
    async (tx) =>
      await readCorpusProjectionUnservedCountsTx(
        asTestRaw<Transaction>(tx),
        TARGET,
      ),
  );
  const read = Result.isError(counts)
    ? panic("The unserved count read failed", counts.error)
    : counts.value;
  const expected = (kind: "at_risk" | "absent") =>
    SEEDS.filter(({ unserved }) => unserved === kind).length;
  expect({
    at_risk: read.at_risk.byIndex.map(({ indexId, count }) => [indexId, count]),
    absent: read.absent.byIndex.map(({ indexId, count }) => [indexId, count]),
    bounds: [read.at_risk.type, read.absent.type],
  }).toEqual({
    at_risk: [[INDEX_ID, expected("at_risk")]],
    absent: [[INDEX_ID, expected("absent")]],
    bounds: ["exact", "exact"],
  });

  // The gauge's reads walk the new indexes, not the tables.
  await run("SET enable_seqscan = off");
  for (const [kind, index] of [
    ["at_risk", "corpus_index_projection_intents_delete_unproven_idx"],
    ["absent", "corpus_index_projection_states_absent_idx"],
  ] as const) {
    // db-await-in-loop: the two kinds' plans
    const plan = await db.execute(
      sql`EXPLAIN (FORMAT JSON) ${corpusProjectionUnservedCountQuery(kind, TARGET)}`,
    );
    expect(JSON.stringify(plan)).toContain(index);
  }
});
