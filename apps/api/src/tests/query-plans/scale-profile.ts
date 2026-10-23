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
  /** Negative values are a fraction of the synthetic table size. */
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
    case_law_decision_citation_stats: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
    case_law_decision_citation_stats_state: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
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
    // 400 days of retention at a few thousand changed runs a day.
    system_audit_runs: { reltuples: 2_000_000, allVisibleFraction: 0.5 },
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
    {
      table: "case_law_decisions",
      column: "ecli",
      nullFraction: 0.14,
      distinctValues: -0.8,
      mostCommonValues: [],
      mostCommonFrequencies: [],
    },
    {
      table: "case_law_decisions",
      column: "language_group_key",
      nullFraction: 0.2,
      distinctValues: -0.4,
      mostCommonValues: [],
      mostCommonFrequencies: [],
    },
    {
      table: "case_law_decisions",
      column: "case_number",
      nullFraction: 0,
      distinctValues: -0.9,
      mostCommonValues: [],
      mostCommonFrequencies: [],
    },
    {
      table: "case_law_decisions",
      column: "docket_family_key",
      nullFraction: 0.5,
      distinctValues: -0.4,
      mostCommonValues: [],
      mostCommonFrequencies: [],
    },
    {
      table: "case_law_decision_identifiers",
      column: "normalized_value",
      nullFraction: 0,
      distinctValues: -0.9,
      mostCommonValues: [],
      mostCommonFrequencies: [],
    },
    {
      table: "legislation_documents",
      column: "slug",
      nullFraction: 0,
      distinctValues: -1,
      mostCommonValues: [],
      mostCommonFrequencies: [],
    },
    {
      table: "legislation_documents",
      column: "eli",
      nullFraction: 0,
      distinctValues: -1,
      mostCommonValues: [],
      mostCommonFrequencies: [],
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
       WHERE n.nspname = current_schema() AND c.relname = ${table}
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

const PROFILED_EXPRESSION_COLUMNS = sql`
  SELECT t.relname AS table_name, c.relname AS index_name, a.attname,
         pg_get_indexdef(i.indexrelid, k.position::int, true) AS expression
    FROM pg_index AS i
    JOIN pg_class AS c ON c.oid = i.indexrelid
    JOIN pg_class AS t ON t.oid = i.indrelid
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
    JOIN pg_attribute AS a
      ON a.attrelid = i.indexrelid AND a.attnum = k.position
   WHERE n.nspname = current_schema()
     AND k.attnum = 0
     AND t.relname IN (${sql.join(
       PLAN_GUARD_TABLES.map((table) => sql`${table}`),
       sql`, `,
     )})
`;

/**
 * An index expression column keeps statistics of its own, which ANALYZE takes
 * from the physical seed and the column restore above does not reach: scaled
 * to the profile's row count, a seed value's frequency reads as hundreds of
 * thousands of matches. Every expression over a profiled column takes that
 * column's null fraction and distinct share instead, so both access paths
 * plan against one distribution. Common values are not carried over; the
 * expression may transform them.
 */
const restoreIndexExpressionStats = async (
  db: ScaleDb,
  profile: ScaleProfile,
): Promise<void> => {
  for (const row of executedRows(
    await db.execute(PROFILED_EXPRESSION_COLUMNS),
  )) {
    if (
      !isRecord(row) ||
      typeof row["table_name"] !== "string" ||
      typeof row["index_name"] !== "string" ||
      typeof row["attname"] !== "string" ||
      typeof row["expression"] !== "string"
    ) {
      return panic("Scale profile index expression row is malformed");
    }
    const { table_name: table, index_name: index, attname, expression } = row;
    const attribute = profile.attributes.find(
      (candidate) =>
        candidate.table === table &&
        new RegExp(`\\b${candidate.column}\\b`, "u").test(expression),
    );
    if (attribute === undefined) {
      continue;
    }
    await db.execute(sql`
      SELECT pg_clear_attribute_stats(
        current_schema()::text, ${index}::text, ${attname}::text, false
      )
    `);
    restored(
      await db.execute(sql`
        SELECT pg_restore_attribute_stats(
          'schemaname', current_schema()::text, 'relname', ${index}::text,
          'attname', ${attname}::text, 'inherited', false,
          'null_frac', ${attribute.nullFraction}::real,
          'n_distinct', ${attribute.distinctValues}::real
        ) AS restored
      `),
      `${index}.${attname}`,
    );
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
          'schemaname', current_schema()::text, 'relname', ${table}::text,
          'reltuples', ${tableProfile.reltuples}::real,
          'relallvisible', ${Math.round(stats.relpages * tableProfile.allVisibleFraction)}::integer
        ) AS restored
      `),
      table,
    );
  }

  for (const attribute of profile.attributes) {
    // ANALYZE's physical-seed MCVs would otherwise survive a partial restore.
    await db.execute(sql`
      SELECT pg_clear_attribute_stats(
        current_schema()::text, ${attribute.table}::text, ${attribute.column}::text, false
      )
    `);
    const commonStats =
      attribute.mostCommonValues.length === 0
        ? sql``
        : sql`, 'most_common_vals', ARRAY[${sql.join(
            attribute.mostCommonValues.map((value) => sql`${value}`),
            sql`, `,
          )}]::text[]::text,
          'most_common_freqs', ARRAY[${sql.join(
            attribute.mostCommonFrequencies.map((value) => sql`${value}::real`),
            sql`, `,
          )}]::real[]`;
    restored(
      await db.execute(sql`
        SELECT pg_restore_attribute_stats(
          'schemaname', current_schema()::text, 'relname', ${attribute.table}::text,
          'attname', ${attribute.column}::text, 'inherited', false,
          'null_frac', ${attribute.nullFraction}::real,
          'n_distinct', ${attribute.distinctValues}::real
          ${commonStats}
        ) AS restored
      `),
      `${attribute.table}.${attribute.column}`,
    );
  }
  await restoreIndexExpressionStats(db, profile);
  await assertScaleProfileApplied(db, profile);
};

/**
 * Scale one seeded table, with its indexes, to the profile's size, for a test
 * that seeds only that table (`injectScaleProfile` needs every guarded table).
 * Partial indexes keep the share of rows they cover. The planner still takes a
 * full index's page count from its file, so a small index looks cheap to read
 * whole: the query's shape, not these numbers, has to keep a path bounded.
 */
export const scaleTableToProfile = async <Table extends string>(
  db: ScaleDb,
  table: Table,
  profile: {
    tables: Record<Table, TableScale>;
    attributes: readonly AttributeScale[];
    /** Scale heap pages when the fixture must model the table-to-index size ratio. */
    scaleRelationPages?: boolean;
  },
): Promise<void> => {
  const scale = profile.tables[table];
  const stats = await relationStats(db, table);
  if (stats.relpages < 1 || stats.reltuples < 1) {
    panic(`Scale profile requires physical rows before scaling: ${table}`);
  }
  const growth = scale.reltuples / stats.reltuples;
  const scaledPages = Math.ceil(stats.relpages * growth);
  const relationPages = profile.scaleRelationPages
    ? sql`, 'relpages', ${scaledPages}::integer`
    : sql``;
  const indexes = executedRows(
    await db.execute(sql`
      SELECT c.relname, c.relpages, c.reltuples
        FROM pg_index AS i
        JOIN pg_class AS c ON c.oid = i.indexrelid
       WHERE i.indrelid = ${table}::regclass
    `),
  );
  if (indexes.length === 0) {
    panic(`Scale profile table has no indexes: ${table}`);
  }
  for (const index of indexes) {
    if (
      !isRecord(index) ||
      typeof index["relname"] !== "string" ||
      typeof index["relpages"] !== "number" ||
      typeof index["reltuples"] !== "number"
    ) {
      return panic(`Scale profile index statistics are malformed: ${table}`);
    }
    restored(
      await db.execute(sql`
        SELECT pg_restore_relation_stats(
          'schemaname', current_schema()::text, 'relname', ${index["relname"]}::text,
          'relpages', ${Math.ceil(index["relpages"] * growth)}::integer,
          'reltuples', ${Math.max(index["reltuples"], 0) * growth}::real
        ) AS restored
      `),
      index["relname"],
    );
  }
  restored(
    await db.execute(sql`
      SELECT pg_restore_relation_stats(
        'schemaname', current_schema()::text, 'relname', ${table}::text,
        'reltuples', ${scale.reltuples}::real,
        'relallvisible', ${Math.round(
          (profile.scaleRelationPages ? scaledPages : stats.relpages) *
            scale.allVisibleFraction,
        )}::integer
        ${relationPages}
      ) AS restored
    `),
    table,
  );
  for (const attribute of profile.attributes) {
    if (attribute.table !== table) {
      continue;
    }
    // The fixture's own distribution would otherwise survive the restore.
    await db.execute(sql`
      SELECT pg_clear_attribute_stats(
        current_schema()::text, ${table}::text, ${attribute.column}::text, false
      )
    `);
    restored(
      await db.execute(sql`
        SELECT pg_restore_attribute_stats(
          'schemaname', current_schema()::text, 'relname', ${table}::text,
          'attname', ${attribute.column}::text, 'inherited', false,
          'null_frac', ${attribute.nullFraction}::real,
          'n_distinct', ${attribute.distinctValues}::real
        ) AS restored
      `),
      `${table}.${attribute.column}`,
    );
  }
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

/** Per-loop visibility-miss upper bound, before an ancestor LIMIT is applied. */
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
