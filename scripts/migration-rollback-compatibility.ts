#!/usr/bin/env bun
// Can the promoted release still run on the schema this checkout's migrations
// leave behind? A deploy rolls back by running the previous release's image
// against the already-migrated database, so every change it cannot tolerate
// is a production outage waiting for the first rollback.
//
//   DATABASE_URL=<upgraded> bun scripts/migration-rollback-compatibility.ts \
//     <base-catalog.json> [--base-release vX.Y.Z]
//
// <base-catalog.json> is `scripts/migration-catalog.ts snapshot` of the
// database right after the promoted release's own migrations ran. That
// release's CI proved its schema.ts matches that catalog, so the catalog is
// what its code reads and writes, less the tables and columns a
// `stella:retired` comment marks. The check compares it with the upgraded
// catalog, names every change the older release cannot tolerate, and runs the
// older release's read and write shape (every declared column) against each of
// its tables. A change is accepted only when a migration applied by this
// upgrade acknowledges `rollback-contract` on the statement that contracts
// that object (scripts/check-migration-safety.ts). Exits 2 when the promoted
// release is incompatible, 1 when the check cannot run.

import { panic, Result } from "better-result";
import { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import {
  checkMigrationSources,
  formatRollbackTarget,
  rollbackTargetKey,
} from "./check-migration-safety";
import type { RollbackTarget } from "./check-migration-safety";
import { snapshotSchema } from "./migration-catalog";
import { isRetiredSchemaComment } from "./migration-retired-schema";

const MIGRATIONS_DIR = path.join(import.meta.dir, "../apps/api/drizzle");
const BASELINE_PATH = path.join(
  import.meta.dir,
  "migration-rollback-baseline.json",
);
// The last migration merged before this check existed. Later migrations carry
// their acknowledgement inline, so the baseline can only shrink.
const BASELINE_CUTOFF = "20261016100400_chat_turn_active_timing_index";
// The migration ledger; no release reads it.
const LEDGER_SCHEMA = "drizzle";
// Constraint kinds that reject rows: check, unique, primary key, foreign key,
// exclusion. NOT NULL is judged per column.
const ROW_CONSTRAINT_TYPES = new Set(["c", "u", "p", "f", "x"]);
const INCOMPATIBLE_EXIT_CODE = 2;

const Text = v.string();
const NullableText = v.nullable(v.string());
const RelationRow = v.object({
  schema: Text,
  name: Text,
  kind: Text,
  comment: NullableText,
});
const CatalogSchema = v.object({
  tables: v.record(Text, RelationRow),
  views: v.record(Text, RelationRow),
  columns: v.record(
    Text,
    v.object({
      schema: Text,
      table: Text,
      name: Text,
      type: Text,
      not_null: v.boolean(),
      default: NullableText,
      identity: Text,
      generated: Text,
      comment: NullableText,
    }),
  ),
  constraints: v.record(
    Text,
    v.object({
      schema: Text,
      // Domain constraints belong to no table.
      table: NullableText,
      name: Text,
      definition: Text,
      type: Text,
      columns: v.array(Text),
    }),
  ),
  indexes: v.record(
    Text,
    v.object({
      schema: Text,
      table: Text,
      name: Text,
      definition: Text,
      unique: v.boolean(),
      constraint_backed: v.boolean(),
      columns: v.array(Text),
    }),
  ),
  functions: v.record(
    Text,
    v.object({ schema: Text, name: Text, arguments: Text }),
  ),
  enums: v.record(Text, v.array(Text)),
  ledger: v.array(Text),
});

type Catalog = v.InferOutput<typeof CatalogSchema>;
type CatalogColumn = Catalog["columns"][string];
type CatalogConstraint = Catalog["constraints"][string];

type RelationName = { schema: string; name: string };
type ColumnName = { schema: string; table: string; column: string };

type RollbackIncompatibility =
  | { type: "relation-removed"; relation: RelationName }
  | { type: "column-removed"; column: ColumnName }
  | {
      type: "column-type-changed";
      column: ColumnName;
      before: string;
      after: string;
    }
  | { type: "not-null-added"; column: ColumnName }
  | { type: "default-removed"; column: ColumnName }
  | { type: "required-column-added"; column: ColumnName }
  | {
      type: "constraint-added";
      relation: RelationName;
      name: string;
      definition: string;
    }
  | {
      type: "constraint-changed";
      relation: RelationName;
      name: string;
      before: string;
      after: string;
    }
  | {
      type: "unique-index-added";
      relation: RelationName;
      name: string;
      definition: string;
    }
  | { type: "enum-value-removed"; enumType: RelationName; value: string }
  | { type: "routine-removed"; routine: RelationName; arguments: string }
  | {
      type: "probe-failed";
      relation: RelationName;
      probe: "read" | "write";
      error: string;
    };

export const parseCatalog = (value: unknown): Catalog =>
  v.parse(CatalogSchema, value);

const relationKey = ({ schema, name }: RelationName): string =>
  JSON.stringify([schema, name]);

const columnKey = ({ schema, table, column }: ColumnName): string =>
  JSON.stringify([schema, table, column]);

const columnName = ({ schema, table, name }: CatalogColumn): ColumnName => ({
  schema,
  table,
  column: name,
});

const relationOf = ({
  schema,
  table,
}: {
  schema: string;
  table: string;
}): RelationName => ({ schema, name: table });

// INSERT may omit the column: the database fills it.
const isDatabaseFilled = (column: CatalogColumn): boolean =>
  column.default !== null || column.identity !== "" || column.generated !== "";

// pg_get_constraintdef marks an unvalidated constraint; validation enforces
// nothing new for writes, which NOT VALID already checks.
const withoutNotValid = (definition: string): string =>
  definition.replace(/ NOT VALID$/u, "");

type ValueList = { column: string; values: Set<string>; allowsNull: boolean };

const VALUE_LIST_PATTERN =
  /^CHECK \((?:(?<nullable>\w+) IS NULL OR \()?\(?(?<column>\w+)\)?(?:::[\w ]+)? = ANY \(ARRAY\[(?<values>[^\]]*)\]\)\)?\)$/u;
const VALUE_LITERAL_PATTERN = /'((?:[^']|'')*)'/gu;

// The closed value list of a text-enum check (`col = ANY (ARRAY[...])`,
// optionally `col IS NULL OR ...`), the one shape whose widening is decidable
// from its definition.
const valueList = (definition: string): ValueList | null => {
  const match = VALUE_LIST_PATTERN.exec(withoutNotValid(definition));
  const column = match?.groups?.["column"];
  const nullable = match?.groups?.["nullable"];
  if (!match || column === undefined) {
    return null;
  }
  if (nullable !== undefined && nullable !== column) {
    return null;
  }
  return {
    column,
    allowsNull: nullable !== undefined,
    values: new Set(
      [...(match.groups?.["values"] ?? "").matchAll(VALUE_LITERAL_PATTERN)].map(
        ([, value]) => (value ?? "").replaceAll("''", "'"),
      ),
    ),
  };
};

const widens = (before: string, after: string): boolean => {
  const old = valueList(before);
  const next = valueList(after);
  return (
    old !== null &&
    next !== null &&
    old.column === next.column &&
    (!old.allowsNull || next.allowsNull) &&
    [...old.values].every((value) => next.values.has(value))
  );
};

const indexShape = (definition: string): string =>
  definition.replace(/^CREATE UNIQUE INDEX \S+ ON /u, "");

const groupBy = <T>(
  rows: Iterable<T>,
  key: (row: T) => string,
): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) {
      group.push(row);
    } else {
      groups.set(key(row), [row]);
    }
  }
  return groups;
};

type BaseRelation = RelationName & { table: boolean };

/** Relations and columns the base release's code reads and writes. */
const usedByBase = (base: Catalog) => {
  const relations = [
    ...Object.values(base.tables).map((row) => ({ ...row, table: true })),
    ...Object.values(base.views).map((row) => ({ ...row, table: false })),
  ]
    .filter(
      ({ schema, comment }) =>
        schema !== LEDGER_SCHEMA && !isRetiredSchemaComment(comment),
    )
    .map(({ schema, name, table }): BaseRelation => ({ schema, name, table }));
  const relationKeys = new Set(relations.map(relationKey));
  const columns = Object.values(base.columns).filter(
    (column) =>
      relationKeys.has(relationKey(relationOf(column))) &&
      !isRetiredSchemaComment(column.comment),
  );
  return { relations, columns };
};

type CompareOptions = { base: Catalog; upgraded: Catalog };

type Comparison = CompareOptions & {
  used: ReturnType<typeof usedByBase>;
  /** Base relations that still exist after the upgrade. */
  surviving: BaseRelation[];
  survivingKeys: ReadonlySet<string>;
  baseColumnsByRelation: ReadonlyMap<string, CatalogColumn[]>;
};

const relationFindings = ({
  used,
  survivingKeys,
}: Comparison): RollbackIncompatibility[] =>
  used.relations
    .filter((relation) => !survivingKeys.has(relationKey(relation)))
    .map(({ schema, name }) => ({
      type: "relation-removed",
      relation: { schema, name },
    }));

const changedColumnFindings = (
  before: CatalogColumn,
  after: CatalogColumn | undefined,
): RollbackIncompatibility[] => {
  const column = columnName(before);
  if (after === undefined) {
    return [{ type: "column-removed", column }];
  }
  const findings: RollbackIncompatibility[] = [];
  if (after.type !== before.type) {
    findings.push({
      type: "column-type-changed",
      column,
      before: before.type,
      after: after.type,
    });
  }
  if (after.not_null && !before.not_null) {
    findings.push({ type: "not-null-added", column });
  } else if (
    after.not_null &&
    isDatabaseFilled(before) &&
    !isDatabaseFilled(after)
  ) {
    findings.push({ type: "default-removed", column });
  }
  return findings;
};

const columnFindings = ({
  base,
  upgraded,
  used,
  surviving,
  survivingKeys,
}: Comparison): RollbackIncompatibility[] => {
  const upgradedColumns = new Map(
    Object.values(upgraded.columns).map((column) => [
      columnKey(columnName(column)),
      column,
    ]),
  );
  const changed = used.columns
    .filter((before) => survivingKeys.has(relationKey(relationOf(before))))
    .flatMap((before) =>
      changedColumnFindings(
        before,
        upgradedColumns.get(columnKey(columnName(before))),
      ),
    );

  const baseColumnKeys = new Set(
    Object.values(base.columns).map((column) => columnKey(columnName(column))),
  );
  const tableKeys = new Set(
    surviving.filter(({ table }) => table).map(relationKey),
  );
  const added = Object.values(upgraded.columns)
    .filter(
      (after) =>
        tableKeys.has(relationKey(relationOf(after))) &&
        !baseColumnKeys.has(columnKey(columnName(after))) &&
        after.not_null &&
        !isDatabaseFilled(after),
    )
    .map((after): RollbackIncompatibility => ({
      type: "required-column-added",
      column: columnName(after),
    }));
  return [...changed, ...added];
};

const constraintsByRelation = (catalog: Catalog) =>
  groupBy(
    Object.values(catalog.constraints).filter(
      (row): row is CatalogConstraint & { table: string } =>
        row.table !== null && ROW_CONSTRAINT_TYPES.has(row.type),
    ),
    (row) => relationKey(relationOf(row)),
  );

const uniqueIndexesByRelation = (catalog: Catalog) =>
  groupBy(
    Object.values(catalog.indexes).filter(
      (row) => row.unique && !row.constraint_backed,
    ),
    (row) => relationKey(relationOf(row)),
  );

const isToleratedConstraint = (
  after: CatalogConstraint,
  before: readonly CatalogConstraint[],
): boolean => {
  const definition = withoutNotValid(after.definition);
  return before.some(
    (row) =>
      (row.type === after.type &&
        withoutNotValid(row.definition) === definition) ||
      (row.type === "c" &&
        after.type === "c" &&
        widens(row.definition, after.definition)),
  );
};

// A constraint or unique index restricts rows of every surviving base table
// whose columns it reads; one over columns the base release never writes holds
// for every row it inserts, as long as the new columns' defaults satisfy it.
// Key constraint types a NULL component exempts a row from: a unique key
// treats NULLs as distinct and a MATCH SIMPLE foreign key skips the row.
const NULL_EXEMPT_KEY_TYPES = new Set(["u", "f"]);

// A key over a column the base release leaves NULL (added after it, nullable,
// no default) never rejects a row that release writes.
const isNullExemptKey = (
  {
    type,
    definition,
    columns,
  }: { type: string; definition: string; columns: string[] },
  nullFilled: ReadonlySet<string>,
): boolean =>
  NULL_EXEMPT_KEY_TYPES.has(type) &&
  !definition.includes("MATCH FULL") &&
  !definition.includes("NULLS NOT DISTINCT") &&
  columns.some((column) => nullFilled.has(column));

const rowRuleFindings = ({
  base,
  upgraded,
  surviving,
  baseColumnsByRelation,
}: Comparison): RollbackIncompatibility[] => {
  const upgradedColumnsByRelation = groupBy(
    Object.values(upgraded.columns),
    (column) => relationKey(relationOf(column)),
  );
  const baseConstraints = constraintsByRelation(base);
  const upgradedConstraints = constraintsByRelation(upgraded);
  const baseIndexes = uniqueIndexesByRelation(base);
  const upgradedIndexes = uniqueIndexesByRelation(upgraded);
  const findings: RollbackIncompatibility[] = [];

  for (const relation of surviving.filter(({ table }) => table)) {
    const key = relationKey(relation);
    const name = { schema: relation.schema, name: relation.name };
    const baseColumnNames = new Set(
      (baseColumnsByRelation.get(key) ?? []).map((column) => column.name),
    );
    const readsBaseColumns = ({ columns }: { columns: string[] }): boolean =>
      columns.length === 0 ||
      columns.some((column) => baseColumnNames.has(column));
    const nullFilled = new Set(
      (upgradedColumnsByRelation.get(key) ?? [])
        .filter(
          (column) =>
            !baseColumnNames.has(column.name) &&
            !column.not_null &&
            !isDatabaseFilled(column),
        )
        .map((column) => column.name),
    );
    const before = baseConstraints.get(key) ?? [];

    for (const after of upgradedConstraints.get(key) ?? []) {
      if (
        !readsBaseColumns(after) ||
        isNullExemptKey(after, nullFilled) ||
        isToleratedConstraint(after, before)
      ) {
        continue;
      }
      const previous = before.find((row) => row.name === after.name);
      findings.push(
        previous
          ? {
              type: "constraint-changed",
              relation: name,
              name: after.name,
              before: previous.definition,
              after: after.definition,
            }
          : {
              type: "constraint-added",
              relation: name,
              name: after.name,
              definition: after.definition,
            },
      );
    }

    const baseShapes = new Set(
      (baseIndexes.get(key) ?? []).map((row) => indexShape(row.definition)),
    );
    for (const after of upgradedIndexes.get(key) ?? []) {
      if (
        readsBaseColumns(after) &&
        // An index's columns include its predicate's, where NULL may match.
        !(
          !after.definition.includes(" WHERE ") &&
          isNullExemptKey({ ...after, type: "u" }, nullFilled)
        ) &&
        !baseShapes.has(indexShape(after.definition))
      ) {
        findings.push({
          type: "unique-index-added",
          relation: name,
          name: after.name,
          definition: after.definition,
        });
      }
    }
  }
  return findings;
};

const enumFindings = ({
  base,
  upgraded,
}: Comparison): RollbackIncompatibility[] =>
  Object.entries(base.enums).flatMap(([key, values]) => {
    const [schema = "", name = ""] = key.split(".");
    if (schema === LEDGER_SCHEMA) {
      return [];
    }
    const remaining = new Set(upgraded.enums[key]);
    return values
      .filter((value) => !remaining.has(value))
      .map((value): RollbackIncompatibility => ({
        type: "enum-value-removed",
        enumType: { schema, name },
        value,
      }));
  });

const routineKey = (row: {
  schema: string;
  name: string;
  arguments: string;
}): string => JSON.stringify([row.schema, row.name, row.arguments]);

const routineFindings = ({
  base,
  upgraded,
}: Comparison): RollbackIncompatibility[] => {
  const remaining = new Set(Object.values(upgraded.functions).map(routineKey));
  return Object.values(base.functions)
    .filter(
      (routine) =>
        routine.schema !== LEDGER_SCHEMA && !remaining.has(routineKey(routine)),
    )
    .map((routine) => ({
      type: "routine-removed",
      routine: { schema: routine.schema, name: routine.name },
      arguments: routine.arguments,
    }));
};

/** Every catalog change the base release cannot tolerate. */
export const findRollbackIncompatibilities = ({
  base,
  upgraded,
}: CompareOptions): RollbackIncompatibility[] => {
  const used = usedByBase(base);
  const upgradedRelations = new Set(
    [...Object.values(upgraded.tables), ...Object.values(upgraded.views)].map(
      relationKey,
    ),
  );
  const surviving = used.relations.filter((relation) =>
    upgradedRelations.has(relationKey(relation)),
  );
  const comparison: Comparison = {
    base,
    upgraded,
    used,
    surviving,
    survivingKeys: new Set(surviving.map(relationKey)),
    baseColumnsByRelation: groupBy(used.columns, (column) =>
      relationKey(relationOf(column)),
    ),
  };
  return [
    relationFindings,
    columnFindings,
    rowRuleFindings,
    enumFindings,
    routineFindings,
  ].flatMap((find) => find(comparison));
};

const rollbackFindingTarget = (
  finding: RollbackIncompatibility,
): RollbackTarget => {
  switch (finding.type) {
    case "relation-removed":
    case "probe-failed": {
      return { type: "relation", ...finding.relation };
    }
    case "constraint-added":
    case "constraint-changed":
    case "unique-index-added": {
      return {
        type: "constraint",
        schema: finding.relation.schema,
        table: finding.relation.name,
        name: finding.name,
      };
    }
    case "column-removed":
    case "column-type-changed":
    case "not-null-added":
    case "default-removed":
    case "required-column-added": {
      return { type: "column", ...finding.column };
    }
    case "enum-value-removed": {
      return { type: "type", ...finding.enumType };
    }
    case "routine-removed": {
      return { type: "routine", ...finding.routine };
    }
    default: {
      finding satisfies never;
      return panic(`unhandled rollback finding: ${JSON.stringify(finding)}`);
    }
  }
};

/**
 * An acknowledged table covers its columns and constraints, an unnamed
 * constraint every constraint of its table; anything else covers itself.
 */
export const coversTarget = (
  acknowledged: RollbackTarget,
  target: RollbackTarget,
): boolean => {
  if (rollbackTargetKey(acknowledged) === rollbackTargetKey(target)) {
    return true;
  }
  if (target.type !== "column" && target.type !== "constraint") {
    return false;
  }
  if (acknowledged.type === "relation") {
    return (
      acknowledged.schema === target.schema &&
      acknowledged.name === target.table
    );
  }
  return (
    acknowledged.type === "constraint" &&
    target.type === "constraint" &&
    acknowledged.name === null &&
    acknowledged.schema === target.schema &&
    acknowledged.table === target.table
  );
};

export const describeRollbackIncompatibility = (
  finding: RollbackIncompatibility,
  baseRelease: string,
): string => {
  const subject = formatRollbackTarget(rollbackFindingTarget(finding));
  switch (finding.type) {
    case "relation-removed": {
      return `${subject}: table or view removed or renamed; ${baseRelease} reads and writes it`;
    }
    case "column-removed": {
      return `${subject}: column removed or renamed; ${baseRelease} selects and inserts it`;
    }
    case "column-type-changed": {
      return `${subject}: type changed from ${finding.before} to ${finding.after}; ${baseRelease} reads and writes ${finding.before}`;
    }
    case "not-null-added": {
      return `${subject}: now NOT NULL; ${baseRelease} may write NULL`;
    }
    case "default-removed": {
      return `${subject}: NOT NULL column lost its database default; ${baseRelease} may insert without it`;
    }
    case "required-column-added": {
      return `${subject}: new NOT NULL column without a default; ${baseRelease} inserts rows without it`;
    }
    case "constraint-added": {
      return `${subject}: new constraint (${finding.definition}); ${baseRelease} may write rows it rejects`;
    }
    case "constraint-changed": {
      return `${subject}: constraint changed from (${finding.before}) to (${finding.after}), not only widened; ${baseRelease} may write rows it rejects`;
    }
    case "unique-index-added": {
      return `${subject}: new unique index (${finding.definition}); ${baseRelease} may write duplicates`;
    }
    case "enum-value-removed": {
      return `${subject}: enum value '${finding.value}' removed; ${baseRelease} may read or write it`;
    }
    case "routine-removed": {
      return `${subject}(${finding.arguments}): routine removed or renamed; ${baseRelease} may call it`;
    }
    case "probe-failed": {
      return `${subject}: ${baseRelease}'s ${finding.probe} of the columns it declares fails: ${finding.error}`;
    }
    default: {
      finding satisfies never;
      return panic(`unhandled rollback finding: ${JSON.stringify(finding)}`);
    }
  }
};

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

// Drizzle names every declared column in a SELECT and an INSERT, so these are
// the shapes of the base release's own reads and writes.
const probeStatements = (
  relation: BaseRelation,
  columns: readonly CatalogColumn[],
): { probe: "read" | "write"; sql: string }[] => {
  const target = `${quote(relation.schema)}.${quote(relation.name)}`;
  const statements: { probe: "read" | "write"; sql: string }[] = [
    {
      probe: "read",
      sql: `SELECT ${columns.map(({ name }) => quote(name)).join(", ") || "1"} FROM ${target} LIMIT 0`,
    },
  ];
  const written = columns.filter(
    ({ generated, identity }) => generated === "" && identity !== "a",
  );
  if (relation.table && written.length > 0) {
    statements.push({
      probe: "write",
      sql: `EXPLAIN (GENERIC_PLAN) INSERT INTO ${target} (${written.map(({ name }) => quote(name)).join(", ")}) VALUES (${written.map((_, index) => `$${String(index + 1)}`).join(", ")})`,
    });
  }
  return statements;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type ProbeOptions = {
  client: SQL;
  base: Catalog;
  explained: ReadonlySet<string>;
};

/** Runs the base release's read and write shape against each relation it uses. */
const probeBaseRelations = async ({
  client,
  base,
  explained,
}: ProbeOptions): Promise<RollbackIncompatibility[]> => {
  const used = usedByBase(base);
  const columnsByRelation = groupBy(used.columns, (column) =>
    relationKey(relationOf(column)),
  );
  const findings: RollbackIncompatibility[] = [];
  for (const relation of used.relations) {
    const key = relationKey(relation);
    // A catalog finding already names why this relation fails.
    if (explained.has(key)) {
      continue;
    }
    const columns = (columnsByRelation.get(key) ?? []).toSorted((left, right) =>
      compareCodeUnit(left.name, right.name),
    );
    for (const { probe, sql } of probeStatements(relation, columns)) {
      const outcome = await Result.tryPromise({
        try: async () => await client.unsafe(sql),
        catch: errorMessage,
      });
      if (outcome.isErr()) {
        findings.push({
          type: "probe-failed",
          relation: { schema: relation.schema, name: relation.name },
          probe,
          error: outcome.error,
        });
      }
    }
  }
  return findings;
};

const RollbackTargetSchema = v.variant("type", [
  v.object({ type: v.literal("relation"), schema: Text, name: Text }),
  v.object({
    type: v.literal("column"),
    schema: Text,
    table: Text,
    column: Text,
  }),
  v.object({ type: v.literal("type"), schema: Text, name: Text }),
  v.object({ type: v.literal("routine"), schema: Text, name: Text }),
  v.object({
    type: v.literal("constraint"),
    schema: Text,
    table: Text,
    name: NullableText,
  }),
]);
const BaselineSchema = v.object({
  entries: v.array(v.object({ migration: Text, target: RollbackTargetSchema })),
});

type BaselineEntry = v.InferOutput<typeof BaselineSchema>["entries"][number];

export const loadBaseline = async (): Promise<BaselineEntry[]> =>
  v.parse(BaselineSchema, await Bun.file(BASELINE_PATH).json()).entries;

export const migrationExists = (name: string): boolean =>
  existsSync(migrationFile(name));

type BaselineProblemsOptions = {
  entries: readonly BaselineEntry[];
  baseMigrations: ReadonlySet<string>;
  baseRelease: string;
  exists: (migration: string) => boolean;
};

/** Entries the baseline must not hold: later, unknown, or already promoted. */
export const baselineProblems = ({
  entries,
  baseMigrations,
  baseRelease,
  exists,
}: BaselineProblemsOptions): string[] =>
  entries.flatMap(({ migration, target }) => {
    const entry = `${migration} (${formatRollbackTarget(target)})`;
    if (compareCodeUnit(migration, BASELINE_CUTOFF) > 0) {
      return [
        `${entry}: postdates ${BASELINE_CUTOFF}; acknowledge rollback-contract in the migration instead`,
      ];
    }
    if (!exists(migration)) {
      return [`${entry}: no such migration`];
    }
    return baseMigrations.has(migration)
      ? [`${entry}: ${baseRelease} already includes it; remove the entry`]
      : [];
  });

const LedgerEntry = v.tuple([Text, Text]);

const ledgerNames = (catalog: Catalog): Set<string> =>
  new Set(
    catalog.ledger.map((entry) => v.parse(LedgerEntry, JSON.parse(entry))[0]),
  );

const migrationFile = (name: string): string =>
  path.join(MIGRATIONS_DIR, name, "migration.sql");

const acknowledgedTargets = (migrations: readonly string[]): RollbackTarget[] =>
  checkMigrationSources(
    migrations.map((name) => ({
      file: migrationFile(name),
      source: readFileSync(migrationFile(name), "utf-8"),
    })),
  ).flatMap(({ acknowledgedRollbackTargets }) => acknowledgedRollbackTargets);

const parseArguments = (args: readonly string[]) => {
  const [baseCatalogPath, flag, baseRelease] = args;
  if (
    baseCatalogPath === undefined ||
    baseCatalogPath.startsWith("-") ||
    (flag !== undefined &&
      (flag !== "--base-release" || baseRelease === undefined)) ||
    args.length > 3
  ) {
    console.error(
      "Usage: DATABASE_URL=<upgraded database> bun scripts/migration-rollback-compatibility.ts <base-catalog.json> [--base-release vX.Y.Z]",
    );
    process.exit(1);
  }
  return {
    baseCatalogPath,
    baseRelease: baseRelease ?? "the promoted release",
  };
};

const main = async () => {
  const { baseCatalogPath, baseRelease } = parseArguments(Bun.argv.slice(2));
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const base = parseCatalog(await Bun.file(baseCatalogPath).json());
  const client = new SQL({ url, max: 1, connectionTimeout: 30 });
  try {
    await client.unsafe("SET statement_timeout = '1min'");
    const upgraded = parseCatalog(await snapshotSchema(client));
    const catalogFindings = findRollbackIncompatibilities({ base, upgraded });
    const explained = new Set(
      catalogFindings.map((finding) => {
        const target = rollbackFindingTarget(finding);
        return relationKey(
          target.type === "column" || target.type === "constraint"
            ? { schema: target.schema, name: target.table }
            : target,
        );
      }),
    );
    const findings = [
      ...catalogFindings,
      ...(await probeBaseRelations({ client, base, explained })),
    ];
    const baseMigrations = ledgerNames(base);
    const migrations = [...ledgerNames(upgraded)]
      .filter((name) => !baseMigrations.has(name))
      .toSorted();
    const entries = await loadBaseline();
    const problems = baselineProblems({
      entries,
      baseMigrations,
      baseRelease,
      exists: migrationExists,
    });
    if (problems.length > 0) {
      console.error(`${BASELINE_PATH} needs pruning:`);
      for (const problem of problems) {
        console.error(`  ${problem}`);
      }
      process.exitCode = 1;
      return;
    }
    const acknowledged = [
      ...acknowledgedTargets(migrations),
      ...entries
        .filter(({ migration }) => migrations.includes(migration))
        .map(({ target }) => target),
    ];
    const isAcknowledged = (finding: RollbackIncompatibility) =>
      acknowledged.some((target) =>
        coversTarget(target, rollbackFindingTarget(finding)),
      );
    const blocking = findings.filter((finding) => !isAcknowledged(finding));

    console.log(
      `Checked ${baseRelease} against ${String(migrations.length)} applied migration(s): ${String(findings.length)} change(s) it cannot tolerate, ${String(findings.length - blocking.length)} acknowledged.`,
    );
    for (const finding of findings.filter(isAcknowledged)) {
      console.log(
        `  acknowledged: ${describeRollbackIncompatibility(finding, baseRelease)}`,
      );
    }
    if (blocking.length === 0) {
      return;
    }
    console.error(
      `Rolling back to ${baseRelease} after these migrations would break it:`,
    );
    for (const finding of blocking) {
      const message = describeRollbackIncompatibility(finding, baseRelease);
      console.error(`  ${message}`);
      if (process.env["GITHUB_ACTIONS"] === "true") {
        console.log(`::error title=rollback-incompatible::${message}`);
      }
    }
    console.error(
      "Split the change: expand now, contract in a release after this one is promoted (docs/releases.md, Migration Policy). If no supported release can observe a change, acknowledge rollback-contract on the statement that makes it, with the reason.",
    );
    process.exitCode = INCOMPATIBLE_EXIT_CODE;
  } finally {
    await client.end();
  }
};

if (import.meta.main) {
  await main();
}
