import { panic } from "better-result";
import { getColumns, isSQLWrapper, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

type ReplayWriteOptions = {
  modifiedAt?: { column: PgColumn; value: Date | SQL };
};

/** SQL values use the very same column encoders as Drizzle's SET builder. */
export const replayWrite = <T extends PgTable>(
  table: T,
  values: PgUpdateSetSource<T>,
  { modifiedAt }: ReplayWriteOptions = {},
) => {
  const columns = getColumns(table);
  const set = new Map<string, SQL>();
  const comparisons: SQL[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    const entry = Object.entries(columns).find(([name]) => name === key);
    const column = entry?.[1];
    if (column === undefined) {
      panic(`Replay cannot write unknown column ${key}`);
    }
    const expression = isSQLWrapper(value)
      ? value.getSQL()
      : sql`${sql.param(value, column)}`;
    set.set(key, expression);
    comparisons.push(sql`${column} IS DISTINCT FROM ${expression}`);
  }
  if (modifiedAt !== undefined) {
    const entry = Object.entries(columns).find(
      ([, column]) => column === modifiedAt.column,
    );
    if (entry === undefined || set.has(entry[0])) {
      panic("Replay modification timestamp must be an unwritten table column");
    }
    const changed =
      comparisons.length === 0
        ? sql`false`
        : sql`(${sql.join(comparisons, sql` OR `)})`;
    const value = isSQLWrapper(modifiedAt.value)
      ? modifiedAt.value.getSQL()
      : sql`${sql.param(modifiedAt.value, modifiedAt.column)}`;
    const expression = sql`CASE WHEN ${changed} THEN ${value} ELSE ${modifiedAt.column} END`;
    set.set(entry[0], expression);
    comparisons.push(sql`${modifiedAt.column} IS DISTINCT FROM ${expression}`);
  }
  for (const [key, column] of Object.entries(columns)) {
    if (column.onUpdateFn !== undefined && !set.has(key)) {
      const changed =
        comparisons.length === 0
          ? sql`false`
          : sql`(${sql.join(comparisons, sql` OR `)})`;
      const value = column.onUpdateFn();
      const bound = isSQLWrapper(value)
        ? value.getSQL()
        : sql`${sql.param(value, column)}`;
      const expression = sql`CASE WHEN ${changed} THEN ${bound} ELSE ${column} END`;
      set.set(key, expression);
      comparisons.push(sql`${column} IS DISTINCT FROM ${expression}`);
    }
  }
  if (comparisons.length === 0) {
    panic("Replay update has no written columns");
  }
  return Object.freeze({
    set: Object.freeze(Object.fromEntries(set)),
    setWhere: sql`(${sql.join(comparisons, sql` OR `)})`,
  });
};

/** An accepted unchanged write is distinct from a failed ownership fence. */
export type ReplayWriteOutcome<T> =
  | { status: "written"; row: T }
  | { status: "unchanged"; row: T }
  | { status: "ownership-lost" };

export const replayWriteOutcome = <T>(
  written: readonly T[],
  matched: readonly T[],
): ReplayWriteOutcome<readonly T[]> => {
  if (written.length > 1 || matched.length > 1) {
    panic("Replay outcome requires a single-row ownership predicate");
  }
  if (written.length > 0) {
    return { status: "written", row: written };
  }
  if (matched.length > 0) {
    return { status: "unchanged", row: matched };
  }
  return { status: "ownership-lost" };
};

/** Raw-session writers share the normalized SET with Drizzle writers. */
export const replayWriteAssignments = (
  table: PgTable,
  { set }: ReturnType<typeof replayWrite>,
): SQL => {
  const columns = getColumns(table);
  return sql.join(
    Object.entries(set).map(([key, value]) => {
      const entry = Object.entries(columns).find(([name]) => name === key);
      const column = entry?.[1];
      if (column === undefined) {
        return panic(`Replay assignment has no column ${key}`);
      }
      return sql`${sql.identifier(column.name)} = ${value}`;
    }),
    sql`, `,
  );
};
