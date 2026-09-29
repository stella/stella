/**
 * A scope transition walks one (country, language) scope of the decision
 * table in id order, a page per call of
 * `run_case_law_provision_scope_transition_page`, from a cursor stored on the
 * transition job. PL/pgSQL may run the function's page read under a generic
 * plan, chosen once without the cursor's value.
 *
 * A later page must therefore start at the cursor on the scope index under a
 * generic plan: a plan that walks the scope from its start and filters reads
 * every earlier row of the scope on every page. The page reads are taken from
 * the migration that defines the function and prepared with the function's
 * variables as parameters, as PL/pgSQL does. The function is also run page by
 * page for its result.
 */

import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import { caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const DB_TEST_TIMEOUT_MS = 120_000;
const SCOPE_INDEX = "case_law_decisions_provision_scope_cursor_idx";
const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../../drizzle");
const KEYSET_MIGRATION = nodePath.join(
  DRIZZLE_DIR,
  "20260929180100_case_law_provision_scope_transition_keyset",
  "migration.sql",
);
const ORIGINAL_MIGRATION = nodePath.join(
  DRIZZLE_DIR,
  "20260926170000_case_law_provision_backfill",
  "migration.sql",
);
/** Decisions per scope in the plan fixture. */
const SCOPE_ROWS = [
  ["CZE", "cs", 12_000],
  ["SVK", "sk", 6000],
  ["ZZP", "pl", 2000],
] as const;
/** Synthetic table size for the scaled pass; a round number, not a measurement. */
const SCALED_DECISION_ROWS = 100_000_000;
/** The function's page size. */
const PAGE_ROWS = 50;
const WALK_ROWS = 2 * PAGE_ROWS + 17;

/**
 * The page reads of the function in `migrationPath`, with the function's
 * variables as the parameters PL/pgSQL binds for them.
 */
const pageReads = async (migrationPath: string): Promise<string[]> => {
  const migration = await Bun.file(migrationPath).text();
  const reads = [
    ...migration.matchAll(
      /SELECT "id"\s+FROM "case_law_decisions"[\s\S]*?FOR NO KEY UPDATE/gu,
    ),
  ].map(([read]) =>
    read
      .replaceAll(/\bjob_country\b/gu, "$$1")
      .replaceAll(/\bjob_language\b/gu, "$$2")
      .replaceAll(/\bjob\."cursor_decision_id"/gu, "$$3"),
  );
  return reads.length > 0
    ? reads
    : panic(`${migrationPath} has no transition page read`);
};

let client: PGlite;
let db: ReturnType<typeof drizzle>;
const sourceId = createSafeId<"caseLawSource">();
let cursor = "";

const nodeTypes = (node: unknown): string[] => {
  if (!isRecord(node)) {
    return [];
  }
  const children = isUnknownArray(node["Plans"]) ? node["Plans"] : [];
  const own = typeof node["Node Type"] === "string" ? [node["Node Type"]] : [];
  return [...own, ...children.flatMap(nodeTypes)];
};

/** The generic plan of `read`, bound to the Czech scope and `cursor`. */
const genericPlan = async (read: string) => {
  const takesCursor = read.includes("$3");
  await client.exec("SET plan_cache_mode = force_generic_plan");
  await client.exec(
    `PREPARE transition_page(varchar, varchar${takesCursor ? ", uuid" : ""}) AS ${read}`,
  );
  try {
    const root = explainRoot(
      await client.query(
        `EXPLAIN (FORMAT JSON) EXECUTE transition_page('CZE', 'cs'${takesCursor ? `, '${cursor}'` : ""})`,
      ),
    );
    return {
      nodeTypes: nodeTypes(root),
      scans: scanOccurrences(root)
        .filter(({ relation }) => relation === "case_law_decisions")
        .map(({ nodeType, index, indexCond, filter }) => ({
          nodeType,
          index,
          boundedOnId: indexCond !== null && /\bid > \$3\b/u.test(indexCond),
          filter,
        })),
    };
  } finally {
    await client.exec("DEALLOCATE transition_page");
    await client.exec("RESET plan_cache_mode");
  }
};

/** One scope-index scan, bounded on the cursor when it takes one, unsorted. */
const expectScopeKeyset = async (read: string) => {
  const plan = await genericPlan(read);
  expect(plan.nodeTypes).not.toContain("Sort");
  expect(plan.nodeTypes).not.toContain("Seq Scan");
  expect(plan.scans).toEqual([
    {
      nodeType: "Index Scan",
      index: SCOPE_INDEX,
      boundedOnId: read.includes("$3"),
      filter: null,
    },
  ]);
};

const insertDecisions = async (
  country: string,
  language: string,
  count: number,
) => {
  await db.execute(sql`
    INSERT INTO case_law_decisions
      (id, source_id, case_number, court, country, language, decision_date,
       metadata)
    SELECT gen_random_uuid(), ${sourceId}::uuid,
      ${`${country}-${language}-`} || i, 'Court', ${country}, ${language},
      DATE '2020-01-01' + (i % 1500), '{}'::jsonb
    FROM generate_series(1, ${count}::int) AS i
  `);
};

const idsOf = (result: unknown): string[] =>
  executedRows(result).map((row) => {
    const id = isRecord(row) ? row["id"] : undefined;
    return typeof id === "string" ? id : panic("row has no text id");
  });

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db
      .insert(caseLawSources)
      .values(caseLawSourceRow({ id: sourceId, name: "transition page plan" }));
    for (const [country, language, count] of SCOPE_ROWS) {
      await insertDecisions(country, language, count);
    }
    await db.execute(sql`VACUUM (ANALYZE) case_law_decisions`);
    const [middle] = idsOf(
      await db.execute(sql`
        SELECT id::text AS id FROM case_law_decisions
        WHERE country = 'CZE' AND language = 'cs'
        ORDER BY case_law_decisions.id OFFSET 6000 LIMIT 1
      `),
    );
    cursor = middle ?? panic("the fixture has no middle decision");
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test(
  "the function's pages read the scope index from the cursor under a generic plan",
  async () => {
    const reads = await pageReads(KEYSET_MIGRATION);
    expect(reads.map((read) => read.includes("$3"))).toEqual([false, true]);
    for (const read of reads) {
      await expectScopeKeyset(read);
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the check rejects the page read with an optional cursor",
  async () => {
    const [read] = await pageReads(ORIGINAL_MIGRATION);
    if (read === undefined) {
      panic("the original migration has no page read");
    }
    // The optional bound is a filter under a generic plan, not an index
    // condition: the page walks the scope from its start.
    const plan = await genericPlan(read);
    expect(plan.scans).not.toEqual([
      {
        nodeType: "Index Scan",
        index: SCOPE_INDEX,
        boundedOnId: true,
        filter: null,
      },
    ]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the function's pages keep the scope index when the table is scaled up",
  async () => {
    const [row] = executedRows(
      await db.execute(sql`
        SELECT pg_restore_relation_stats(
          'schemaname', 'public', 'relname', 'case_law_decisions',
          'reltuples', ${SCALED_DECISION_ROWS}::real,
          'relpages', (${SCALED_DECISION_ROWS}::double precision
            * relpages / reltuples)::integer
        ) AS restored
        FROM pg_class WHERE oid = 'case_law_decisions'::regclass
      `),
    );
    if (!isRecord(row) || row["restored"] !== true) {
      panic("could not scale the decision table's statistics");
    }
    for (const read of await pageReads(KEYSET_MIGRATION)) {
      await expectScopeKeyset(read);
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a transition visits every decision of its scope once, in id order",
  async () => {
    await insertDecisions("ZZP", "t1", WALK_ROWS);
    // A neighbouring scope the walk must not touch.
    await insertDecisions("ZZP", "t2", PAGE_ROWS);
    await db.execute(sql`UPDATE case_law_provision_extraction_scopes
      SET status = 'active', generation = generation + 1
      WHERE country = 'ZZP' AND language = 't1'`);
    await db.execute(sql`INSERT INTO case_law_provision_scope_transitions
      (country, language, generation, action)
      SELECT country, language, generation, 'activate'
      FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 't1'`);
    const [scope] = executedRows(
      await db.execute(sql`SELECT generation::text AS generation
        FROM case_law_provision_extraction_scopes
        WHERE country = 'ZZP' AND language = 't1'`),
    );
    const generation = isRecord(scope) ? scope["generation"] : undefined;
    if (typeof generation !== "string") {
      panic("the walked scope has no generation");
    }
    const ordered = idsOf(
      await db.execute(sql`SELECT id::text AS id FROM case_law_decisions
        WHERE country = 'ZZP' AND language = 't1'
        ORDER BY case_law_decisions.id`),
    );

    const cursors: (string | null)[] = [];
    const results: unknown[] = [];
    for (let call = 0; call < 10; call += 1) {
      const [result] = executedRows(
        await db.execute(sql`SELECT run_case_law_provision_scope_transition_page(
          'ZZP', 't1', ${generation}::bigint) AS more`),
      );
      results.push(isRecord(result) ? result["more"] : undefined);
      const [job] = executedRows(
        await db.execute(sql`SELECT cursor_decision_id::text AS cursor
          FROM case_law_provision_scope_transitions
          WHERE country = 'ZZP' AND language = 't1'`),
      );
      const jobCursor = isRecord(job) ? job["cursor"] : undefined;
      cursors.push(typeof jobCursor === "string" ? jobCursor : null);
      if (results.at(-1) === false) {
        break;
      }
    }

    // Three pages, then an empty page that completes the job.
    expect(results).toEqual([true, true, true, false]);
    expect(cursors).toEqual([
      ordered[PAGE_ROWS - 1],
      ordered[2 * PAGE_ROWS - 1],
      ordered.at(-1),
      ordered.at(-1),
    ]);
    expect(
      executedRows(
        await db.execute(sql`SELECT completed_at IS NOT NULL AS completed
          FROM case_law_provision_scope_transitions
          WHERE country = 'ZZP' AND language = 't1'`),
      ),
    ).toEqual([{ completed: true }]);
    expect(
      idsOf(
        await db.execute(sql`SELECT state.decision_id::text AS id
          FROM case_law_provision_extractions state
          JOIN case_law_decisions decision ON decision.id = state.decision_id
          WHERE decision.country = 'ZZP'
            AND decision.language IN ('t1', 't2')
            AND state.enqueue_reason = 'scope_activated'
          ORDER BY state.decision_id`),
      ),
    ).toEqual(ordered);
  },
  DB_TEST_TIMEOUT_MS,
);
