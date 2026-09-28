import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

import { PLAN_GUARD_TABLES } from "../../db/plan-guard-tables";

type GuardedTable = (typeof PLAN_GUARD_TABLES)[number];

type TableScale = {
  reltuples: number;
  allVisibleFraction: number;
};

type AttributeScale = {
  table: GuardedTable;
  column: string;
  nullFraction: number;
  distinctValues: number;
  mostCommonValues: readonly string[];
  mostCommonFrequencies: readonly number[];
};

export type ScaleProfile = {
  tables: Record<GuardedTable, TableScale>;
  attributes: readonly AttributeScale[];
};

/** Round synthetic sizes; no catalog observations or corpus values belong here. */
export const SYNTHETIC_SCALE_PROFILE = {
  tables: {
    case_law_citations: { reltuples: 100_000_000, allVisibleFraction: 0.2 },
    case_law_decision_identifiers: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
    case_law_decisions: { reltuples: 100_000_000, allVisibleFraction: 0.5 },
    case_law_index_jobs: { reltuples: 100_000_000, allVisibleFraction: 0.5 },
    case_law_provision_citations: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
    case_law_provision_extractions: {
      reltuples: 10_000_000,
      allVisibleFraction: 0.5,
    },
    case_law_statute_citation_memberships: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
    case_law_search_document_preview_passages: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
    case_law_search_documents: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
    corpus_index_projection_intents: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
    corpus_index_projection_states: {
      reltuples: 10_000_000,
      allVisibleFraction: 0.5,
    },
    legislation_index_jobs: { reltuples: 1_000_000, allVisibleFraction: 0.5 },
    legislation_documents: { reltuples: 1_000_000, allVisibleFraction: 0.5 },
    legislation_search_documents: {
      reltuples: 1_000_000,
      allVisibleFraction: 0.5,
    },
  },
  attributes: [
    {
      table: "case_law_decisions",
      column: "country",
      nullFraction: 0,
      distinctValues: 3,
      mostCommonValues: ["CZE", "SVK", "POL"],
      mostCommonFrequencies: [0.5, 0.3, 0.2],
    },
    {
      table: "case_law_decisions",
      column: "language",
      nullFraction: 0,
      distinctValues: 4,
      mostCommonValues: ["cs", "sk", "pl", "en"],
      mostCommonFrequencies: [0.4, 0.3, 0.2, 0.1],
    },
    {
      table: "case_law_decision_identifiers",
      column: "type",
      nullFraction: 0,
      distinctValues: 4,
      mostCommonValues: [
        DECISION_IDENTIFIER_TYPES.ECLI,
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
        DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      ],
      mostCommonFrequencies: [0.4, 0.3, 0.2, 0.1],
    },
  ],
} as const satisfies ScaleProfile;

type ScaleDb = { execute: (query: SQL) => PromiseLike<unknown> };

type RelationStats = {
  relpages: number;
  reltuples: number;
  relallvisible: number;
};

const relationStats = async (
  db: ScaleDb,
  table: string,
): Promise<RelationStats> => {
  const rows = executedRows(
    await db.execute(sql`
      SELECT c.relpages, c.reltuples, c.relallvisible
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ${table}
    `),
  );
  const row = rows.at(0);
  if (rows.length !== 1 || !isRecord(row)) {
    return panic(`Scale profile relation is missing: ${table}`);
  }
  const { relpages, reltuples, relallvisible } = row;
  if (
    typeof relpages !== "number" ||
    typeof reltuples !== "number" ||
    typeof relallvisible !== "number"
  ) {
    return panic(`Scale profile relation stats are malformed: ${table}`);
  }
  return { relpages, reltuples, relallvisible };
};

const restored = (result: unknown, table: string): void => {
  const row = executedRows(result).at(0);
  if (!isRecord(row) || row["restored"] !== true) {
    panic(`Scale profile restore failed: ${table}`);
  }
};

/** Run only after the physical seed and its final ANALYZE. */
export const injectScaleProfile = async (
  db: ScaleDb,
  profile: ScaleProfile,
): Promise<void> => {
  for (const table of PLAN_GUARD_TABLES) {
    const stats = await relationStats(db, table);
    if (stats.relpages < 1) {
      panic(`Scale profile requires physical pages before injection: ${table}`);
    }
    const tableProfile = profile.tables[table];
    restored(
      await db.execute(sql`
        SELECT pg_restore_relation_stats(
          'schemaname', 'public', 'relname', ${table}::text,
          'reltuples', ${tableProfile.reltuples}::real,
          'relallvisible', ${Math.round(stats.relpages * tableProfile.allVisibleFraction)}::integer
        ) AS restored
      `),
      table,
    );
  }

  for (const attribute of profile.attributes) {
    const commonValues = sql`ARRAY[${sql.join(
      attribute.mostCommonValues.map((value) => sql`${value}`),
      sql`, `,
    )}]::text[]::text`;
    const commonFrequencies = sql`ARRAY[${sql.join(
      attribute.mostCommonFrequencies.map((value) => sql`${value}::real`),
      sql`, `,
    )}]::real[]`;
    restored(
      await db.execute(sql`
        SELECT pg_restore_attribute_stats(
          'schemaname', 'public', 'relname', ${attribute.table}::text,
          'attname', ${attribute.column}::text, 'inherited', false,
          'null_frac', ${attribute.nullFraction}::real,
          'n_distinct', ${attribute.distinctValues}::real,
          'most_common_vals', ${commonValues},
          'most_common_freqs', ${commonFrequencies}
        ) AS restored
      `),
      `${attribute.table}.${attribute.column}`,
    );
  }
  await assertScaleProfileApplied(db, profile);
};

/** Detect an ANALYZE or incomplete seed before any plan is judged. */
export const assertScaleProfileApplied = async (
  db: ScaleDb,
  profile: ScaleProfile,
): Promise<void> => {
  for (const table of PLAN_GUARD_TABLES) {
    const stats = await relationStats(db, table);
    const expected = profile.tables[table];
    const visiblePages = Math.round(
      stats.relpages * expected.allVisibleFraction,
    );
    if (
      stats.relpages < 1 ||
      stats.reltuples < expected.reltuples ||
      stats.relallvisible !== visiblePages
    ) {
      panic(`Scale profile was overwritten or not applied: ${table}`);
    }
  }
};

type ScanEstimate = {
  nodeType: string;
  relation: string;
  rows: number | null;
};

const guardedTables: ReadonlySet<string> = new Set(PLAN_GUARD_TABLES);
const isGuardedTable = (table: string): table is GuardedTable =>
  guardedTables.has(table);

/** Estimated visibility misses, not measured EXPLAIN ANALYZE heap fetches. */
export const estimateHeapFetches = (
  node: ScanEstimate,
  profile: ScaleProfile,
): number | null => {
  if (node.nodeType !== "Index Only Scan" || !isGuardedTable(node.relation)) {
    return null;
  }
  if (node.rows === null) {
    return panic(`Index Only Scan has no row estimate: ${node.relation}`);
  }
  return node.rows * (1 - profile.tables[node.relation].allVisibleFraction);
};
