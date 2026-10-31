import { panic } from "better-result";
import { getColumns, isSQLWrapper, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias as tableAlias, PgDialect } from "drizzle-orm/pg-core";
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

const replayWriteAssignments = (
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

type RawReplayOperation =
  | { kind: "update"; from?: SQL }
  | {
      kind: "upsert";
      columns: readonly PgColumn[];
      source: SQL;
      target: readonly PgColumn[];
    };
type RawReplayResult =
  | { kind: "rows"; columns: SQL }
  | { kind: "query"; columns: SQL; name: string; query: SQL };
type RawReplayWriteOptions<T extends PgTable> = {
  table: T;
  values: PgUpdateSetSource<T>;
  predicate: SQL;
  operation: RawReplayOperation;
  alias?: string;
  ctes?: readonly { name: string; query: SQL }[];
  result?: RawReplayResult;
};

type RawReplayExecutor =
  | {
      kind: "drizzle";
      connection: { execute: (query: SQLWrapper) => PromiseLike<unknown> };
    }
  | {
      kind: "session";
      connection: {
        query: (
          query: string,
          params?: ReturnType<PgDialect["sqlToQuery"]>["params"],
        ) => PromiseLike<unknown>;
      };
    };

/** Own the complete statement so distinctness cannot be moved out of its WHERE. */
export const replayRawWrite = <T extends PgTable>({
  table,
  values,
  predicate,
  operation,
  alias,
  ctes = [],
  result,
}: RawReplayWriteOptions<T>) => {
  const target = alias === undefined ? table : tableAlias(table, alias);
  const plan = replayWrite(target, values);
  const assignments = replayWriteAssignments(target, plan);
  const relation =
    alias === undefined
      ? sql`${table}`
      : sql`${table} AS ${sql.identifier(alias)}`;
  const where = sql`(${predicate}) AND (${plan.setWhere})`;
  const returning =
    result === undefined ? sql`` : sql` RETURNING ${result.columns}`;
  const mutation = (() => {
    switch (operation.kind) {
      case "update":
        return sql`UPDATE ${relation} SET ${assignments}${operation.from === undefined ? sql`` : sql` FROM ${operation.from}`} WHERE ${where}${returning}`;
      case "upsert":
        if (operation.columns.length === 0 || operation.target.length === 0) {
          return panic("Raw replay upsert needs input and conflict columns");
        }
        return sql`INSERT INTO ${relation} (${sql.join(
          operation.columns.map((column) => sql.identifier(column.name)),
          sql`, `,
        )}) ${operation.source} ON CONFLICT (${sql.join(
          operation.target.map((column) => sql.identifier(column.name)),
          sql`, `,
        )}) DO UPDATE SET ${assignments} WHERE ${where}${returning}`;
      default:
        operation satisfies never;
        return panic("Unknown raw replay operation");
    }
  })();
  const definitions = ctes.map(
    ({ name, query }) => sql`${sql.identifier(name)} AS (${query})`,
  );
  const statement = (() => {
    switch (result?.kind) {
      case "query":
        definitions.push(sql`${sql.identifier(result.name)} AS (${mutation})`);
        return sql`WITH ${sql.join(definitions, sql`, `)} ${result.query}`;
      case "rows":
      case undefined:
        return definitions.length === 0
          ? mutation
          : sql`WITH ${sql.join(definitions, sql`, `)} ${mutation}`;
      default:
        result satisfies never;
        return panic("Unknown raw replay result");
    }
  })();
  // The SQL stays private: callers receive an executable statement, never a
  // fragment they can append to or place in another clause.
  return Object.freeze({
    execute: async (executor: RawReplayExecutor): Promise<unknown> => {
      switch (executor.kind) {
        case "drizzle":
          return await executor.connection.execute(statement);
        case "session": {
          const query = new PgDialect().sqlToQuery(statement);
          return await executor.connection.query(query.sql, query.params);
        }
        default:
          executor satisfies never;
          return panic("Unknown raw replay executor");
      }
    },
  });
};
