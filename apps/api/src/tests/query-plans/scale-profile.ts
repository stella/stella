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
    case_law_population_deltas: {
      reltuples: 1_000_000,
      allVisibleFraction: 0.5,
    },
    case_law_population_projections: {
      reltuples: 100_000_000,
      allVisibleFraction: 0.5,
    },
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
      column: "citation_key",
      nullFraction: 0.2,
      distinctValues: -0.7,
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

/**
 * One node string per expression of a `pg_index.indexprs` list, in index
 * column order. Node strings escape their own braces with a backslash.
 */
const indexExpressionNodes = (tree: string): string[] => {
  const nodes: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < tree.length; at += 1) {
    const char = tree[at];
    if (char === "\\") {
      at += 1;
    } else if (char === "{") {
      if (depth === 0) {
        start = at;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        nodes.push(tree.slice(start, at + 1));
      }
    }
  }
  if (depth !== 0) {
    return panic(`Malformed index expression tree: ${tree}`);
  }
  return nodes;
};

/** The table column numbers one expression node reads. */
const expressionColumnNumbers = (node: string): number[] => {
  const numbers = Array.from(
    node.matchAll(/\{VAR :varno \d+ :varattno (-?\d+) /gu),
    (match) => Number(match[1]),
  );
  // A node format this does not read must not look like a constant.
  if (numbers.length !== node.split("{VAR ").length - 1) {
    return panic(`Unreadable column reference in index expression: ${node}`);
  }
  return [...new Set(numbers)];
};

type ExpressionColumnScale = {
  index: string;
  /** The index column's own name, which `pg_stats` lists it under. */
  column: string;
  attnum: number;
  source: AttributeScale;
};

const textField = (row: unknown, field: string, table: string): string => {
  const value = isRecord(row) ? row[field] : undefined;
  return typeof value === "string"
    ? value
    : panic(`Scale profile index catalog row is malformed: ${table}`);
};

/**
 * Expression columns of full indexes that read a profiled column. The
 * planner takes an expression's statistics only from a full index (a
 * partial index's are ignored), and ANALYZE took those from the physical
 * seed: once the profile rewrites the column, the expression must follow it
 * or its estimates describe a different table. An expression that maps the
 * seed's values one to one (same distinct count, NULL exactly where the
 * column is) has the column's distribution; any other expression over a
 * profiled column has no honest statistics here and fails the gate.
 */
const expressionColumnScales = async (
  db: ScaleDb,
  tables: readonly string[],
  attributes: readonly AttributeScale[],
): Promise<ExpressionColumnScale[]> => {
  const scales: ExpressionColumnScale[] = [];
  for (const table of tables) {
    const profiled = attributes.filter(
      (attribute) => attribute.table === table,
    );
    const indexes = executedRows(
      await db.execute(sql`
        SELECT c.relname AS name, i.indexrelid::oid::text AS oid,
               i.indkey::text AS keys, i.indexprs::text AS expressions
          FROM pg_index AS i
          JOIN pg_class AS c ON c.oid = i.indexrelid
         WHERE i.indrelid = ${table}::regclass
           AND i.indexprs IS NOT NULL
           AND i.indpred IS NULL
         ORDER BY c.relname
      `),
    );
    if (indexes.length === 0) {
      continue;
    }
    const columns = new Map(
      executedRows(
        await db.execute(sql`
          SELECT attnum::text AS attnum, attname
            FROM pg_attribute
           WHERE attrelid = ${table}::regclass AND attnum > 0
        `),
      ).map((row) => [
        Number(textField(row, "attnum", table)),
        textField(row, "attname", table),
      ]),
    );
    for (const index of indexes) {
      const name = textField(index, "name", table);
      const oid = textField(index, "oid", table);
      const nodes = indexExpressionNodes(
        textField(index, "expressions", table),
      );
      const expressionPositions = textField(index, "keys", table)
        .split(" ")
        .flatMap((key, at) => (key === "0" ? [at + 1] : []));
      if (expressionPositions.length !== nodes.length) {
        return panic(`Scale profile misread index expressions: ${name}`);
      }
      for (const [at, attnum] of expressionPositions.entries()) {
        const sources = expressionColumnNumbers(nodes[at] ?? "").map(
          (number) =>
            columns.get(number) ??
            panic(`Scale profile index reads an unknown column: ${name}`),
        );
        const profiledSources = profiled.filter(({ column }) =>
          sources.includes(column),
        );
        if (profiledSources.length === 0) {
          continue;
        }
        const definition = executedRows(
          await db.execute(sql`
            SELECT pg_get_indexdef(${oid}::oid, ${attnum}::integer, true) AS expression,
                   a.attname AS column
              FROM pg_attribute AS a
             WHERE a.attrelid = ${oid}::oid AND a.attnum = ${attnum}
          `),
        ).at(0);
        const expression = textField(definition, "expression", name);
        const [source] = profiledSources;
        if (sources.length !== 1 || source === undefined) {
          return panic(
            `Scale profile has no statistics for ${name} expression ${expression}: it reads a profiled column among others`,
          );
        }
        const seed = executedRows(
          await db.execute(sql`
            SELECT count(DISTINCT (${sql.raw(expression)})) =
                     count(DISTINCT ${sql.identifier(source.column)})
                   AND bool_and(
                     ((${sql.raw(expression)}) IS NULL) =
                       (${sql.identifier(source.column)} IS NULL)
                   ) IS NOT FALSE AS one_to_one
              FROM ${sql.identifier(table)}
          `),
        ).at(0);
        if (!isRecord(seed) || seed["one_to_one"] !== true) {
          return panic(
            `Scale profile has no statistics for ${name} expression ${expression}: it does not map ${source.column} one to one`,
          );
        }
        scales.push({
          index: name,
          column: textField(definition, "column", name),
          attnum,
          source,
        });
      }
    }
  }
  return scales;
};

/** Give each expression over a profiled column that column's statistics. */
const injectExpressionColumnStats = async (
  db: ScaleDb,
  tables: readonly string[],
  attributes: readonly AttributeScale[],
): Promise<void> => {
  for (const scale of await expressionColumnScales(db, tables, attributes)) {
    // ANALYZE's seed MCVs are values of the seed, not of the profile.
    await db.execute(sql`
      SELECT pg_clear_attribute_stats(
        current_schema()::text, ${scale.index}::text, ${scale.column}::text, false
      )
    `);
    restored(
      await db.execute(sql`
        SELECT pg_restore_attribute_stats(
          'schemaname', current_schema()::text, 'relname', ${scale.index}::text,
          'attnum', ${scale.attnum}::smallint, 'inherited', false,
          'null_frac', ${scale.source.nullFraction}::real,
          'n_distinct', ${scale.source.distinctValues}::real
        ) AS restored
      `),
      `${scale.index}.${scale.column}`,
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
  await injectExpressionColumnStats(db, PLAN_GUARD_TABLES, profile.attributes);
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
  await injectExpressionColumnStats(db, [table], profile.attributes);
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
  const expressions = await expressionColumnScales(
    db,
    PLAN_GUARD_TABLES,
    profile.attributes,
  );
  for (const { index, column, source } of expressions) {
    const row = executedRows(
      await db.execute(sql`
        SELECT null_frac, n_distinct, most_common_vals IS NULL AS no_common_values
          FROM pg_stats
         WHERE schemaname = current_schema()
           AND tablename = ${index} AND attname = ${column}
      `),
    ).at(0);
    if (
      !isRecord(row) ||
      typeof row["null_frac"] !== "number" ||
      typeof row["n_distinct"] !== "number" ||
      Math.abs(row["null_frac"] - source.nullFraction) > 1e-6 ||
      Math.abs(row["n_distinct"] - source.distinctValues) > 1e-6 ||
      row["no_common_values"] !== true
    ) {
      panic(
        `Scale profile left an index expression on seed statistics: ${index}.${column}`,
      );
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
