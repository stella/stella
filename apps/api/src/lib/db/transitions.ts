import { panic } from "better-result";
import { getColumns, isSQLWrapper, sql } from "drizzle-orm";
import type { DriverValueDecoder, GetColumnData, SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type {
  AnyPgColumn,
  PgTable,
  PgUpdateSetSource,
} from "drizzle-orm/pg-core";

type StatusTable = PgTable & { status: AnyPgColumn };
type LifecycleTable = StatusTable & { id: AnyPgColumn };
type Status<TTable extends StatusTable> = GetColumnData<TTable["status"]> &
  string;
type FenceKey<TTable extends StatusTable> = Extract<
  keyof TTable["_"]["columns"],
  "leaseToken" | "attempt" | "claimedAt"
>;

export type TransitionSpec = {
  readonly table: PgTable;
  readonly edges: Readonly<Record<string, readonly string[]>>;
  readonly terminal: readonly string[];
  readonly fence: string | undefined;
};

/** Same-state writes preserve metadata without reopening a lifecycle. */
export const permitsTransition = (
  spec: Pick<TransitionSpec, "edges">,
  from: string,
  to: string,
): boolean => {
  const targets = spec.edges[from];
  return targets !== undefined && (from === to || targets.includes(to));
};

type LifecycleGraphCheck = {
  column: AnyPgColumn;
  edges: Readonly<Record<string, readonly string[]>>;
  terminal: readonly string[];
};

const assertLifecycleGraph = ({
  column,
  edges,
  terminal,
}: LifecycleGraphCheck) => {
  const statuses = column.enumValues;
  if (
    statuses === undefined ||
    statuses.some((status) => !Object.hasOwn(edges, status)) ||
    Object.keys(edges).some((status) => !statuses.includes(status))
  ) {
    panic("A transition graph must cover the column's closed status domain");
  }
  for (const [from, targets] of Object.entries<readonly string[]>(edges)) {
    if (targets.some((to) => !statuses.includes(to))) {
      panic(`Unknown transition target from ${from}`);
    }
    if (
      terminal.some((status) => status === from) &&
      targets.some((to) => to !== from)
    ) {
      panic(`Terminal status ${from} cannot have outgoing transitions`);
    }
  }
  if (terminal.some((status) => !Object.hasOwn(edges, status))) {
    panic("Unknown terminal status");
  }
};

const assertTransitionFence = (table: PgTable, fence: string | undefined) => {
  if (fence !== undefined && !Object.hasOwn(getColumns(table), fence)) {
    panic("The declared transition fence is not a table column");
  }
};

const assertTransitionIdentity = (table: PgTable, key: string) => {
  // Runtime callers can supply keys outside the generic column domain.
  const runtimeColumns: Readonly<Record<string, AnyPgColumn>> =
    getColumns(table);
  const identity = runtimeColumns[key];
  // Named primary-key constraints leave the column's own flag unset.
  const constrained = getTableConfig(table).primaryKeys.some(
    ({ columns }) =>
      columns.length === 1 && columns.at(0)?.name === identity?.name,
  );
  if (identity === undefined || !(identity.primary || constrained)) {
    panic("A transition identity must be a primary-key column");
  }
};

/** The returned table handle carries the literal graph into every writer. */
export const defineTransitions = <
  TTable extends LifecycleTable,
  const TEdges extends Readonly<
    Record<Status<TTable>, readonly Status<TTable>[]>
  >,
  const TOptions extends {
    terminal: readonly Status<TTable>[];
    fence?: FenceKey<TTable>;
  },
>(
  table: TTable,
  edges: TEdges,
  options: TOptions,
) => defineKeyedTransitions({ table, key: "id", edges, options });

type DefineKeyedTransitionsArgs<
  TTable extends StatusTable,
  TKey extends keyof TTable["_"]["columns"] & string,
  TEdges extends Readonly<Record<Status<TTable>, readonly Status<TTable>[]>>,
  TOptions extends {
    terminal: readonly Status<TTable>[];
    fence?: FenceKey<TTable>;
  },
> = { table: TTable; key: TKey; edges: TEdges; options: TOptions };

/** Tables with a domain primary key retain their real column identity. */
export const defineKeyedTransitions = <
  TTable extends StatusTable,
  const TKey extends keyof TTable["_"]["columns"] & string,
  const TEdges extends Readonly<
    Record<Status<TTable>, readonly Status<TTable>[]>
  >,
  const TOptions extends {
    terminal: readonly Status<TTable>[];
    fence?: FenceKey<TTable>;
  },
>({
  table,
  key,
  edges,
  options,
}: DefineKeyedTransitionsArgs<TTable, TKey, TEdges, TOptions>) => {
  const idColumn = getColumns(table)[key];
  assertLifecycleGraph({
    column: table.status,
    edges,
    terminal: options.terminal,
  });
  assertTransitionFence(table, options.fence);
  assertTransitionIdentity(table, key);
  for (const targets of Object.values<readonly string[]>(edges)) {
    Object.freeze(targets);
  }
  return Object.freeze({
    table,
    key,
    idColumn,
    edges: Object.freeze(edges),
    options: Object.freeze(options),
    terminal: Object.freeze([...options.terminal]),
    fence: options.fence,
  });
};

type DefinedTransitions<
  TTable extends LifecycleTable,
  TEdges extends Readonly<Record<string, readonly string[]>>,
  TOptions extends { terminal: readonly string[]; fence?: string },
> = TransitionSpec & { table: TTable; options: TOptions; edges: TEdges };

type Move<TEdges extends Readonly<Record<string, readonly string[]>>> = {
  [TTarget in keyof TEdges & string]: {
    to: TTarget;
    from: readonly [
      {
        [TSource in keyof TEdges & string]: TTarget extends
          | TSource
          | TEdges[TSource][number]
          ? TSource
          : never;
      }[keyof TEdges & string],
      ...{
        [TSource in keyof TEdges & string]: TTarget extends
          | TSource
          | TEdges[TSource][number]
          ? TSource
          : never;
      }[keyof TEdges & string][],
    ];
  };
}[keyof TEdges & string];

type Fence<
  TTable extends StatusTable,
  TOptions extends { fence?: string },
> = TOptions extends { fence: infer TKey extends keyof TTable["_"]["columns"] }
  ? { fence: GetColumnData<TTable["_"]["columns"][TKey]> }
  : { fence?: never };

type TransitionOwnedKeys<TOptions> =
  | "id"
  | "status"
  | (TOptions extends { fence: infer TKey extends string } ? TKey : never);

type TransitionOptions<
  TTable extends LifecycleTable,
  TEdges extends Readonly<Record<string, readonly string[]>>,
  TOptions extends { fence?: string },
> = Move<TEdges> &
  Fence<TTable, TOptions> & {
    set?: Omit<PgUpdateSetSource<TTable>, TransitionOwnedKeys<TOptions>> &
      Partial<Record<TransitionOwnedKeys<TOptions>, never>>;
  };

export type TransitionResult<TId, TStatus> =
  | { type: "transitioned"; row: { id: TId; status: TStatus } }
  | { type: "stale" };

type TransitionTransaction = {
  execute: (query: SQL) => PromiseLike<Record<string, unknown>[]>;
  rollback: () => never;
};

type TransitionArgs<
  TTx extends TransitionTransaction,
  TTable extends LifecycleTable,
  TEdges extends Readonly<Record<string, readonly string[]>>,
  TOptions extends { terminal: readonly string[]; fence?: string },
> = {
  tx: TTx;
  spec: DefinedTransitions<TTable, TEdges, TOptions>;
  id: GetColumnData<TTable["id"]>;
  options: TransitionOptions<
    NoInfer<TTable>,
    NoInfer<TEdges>,
    NoInfer<TOptions>
  >;
  recordTransitionAuditEvent: (
    tx: TTx,
    row: { id: GetColumnData<TTable["id"]>; status: Status<TTable> },
  ) => Promise<void>;
};

type LifecycleMove = {
  key: string;
  column: AnyPgColumn;
  edges: Readonly<Record<string, readonly string[]>>;
  from: readonly string[];
  to: string;
};

type LifecycleUpdateArgs = {
  tx: TransitionTransaction;
  table: PgTable;
  identity: { key: string; column: AnyPgColumn };
  ids: readonly unknown[];
  match: "one" | "many";
  moves: readonly LifecycleMove[];
  set: Readonly<Record<string, unknown>> | undefined;
  fence: { key: string | undefined; value: unknown };
  recordTransitionAuditEvent: (
    rows: readonly Record<string, unknown>[],
  ) => Promise<void>;
};

/** One conditional update; every moved column's expected sources join its predicate. */
const lifecycleUpdate = async ({
  tx,
  table,
  identity,
  ids,
  match,
  moves,
  set = {},
  fence: { key: fenceKey, value: expectedFence },
  recordTransitionAuditEvent,
}: LifecycleUpdateArgs) => {
  if (
    moves.length === 0 ||
    moves.some(
      (move) =>
        move.from.length === 0 ||
        move.from.some((from) => !permitsTransition(move, from, move.to)),
    )
  ) {
    panic("Illegal status transition");
  }
  const columns = getColumns(table);
  const owned = new Set([
    identity.key,
    ...moves.map(({ key }) => key),
    ...(fenceKey === undefined ? [] : [fenceKey]),
  ]);
  const assignments = moves.map(
    ({ column, to }) => sql`${sql.identifier(column.name)} = ${to}`,
  );
  for (const [key, value] of Object.entries(set)) {
    const column = columns[key];
    if (column === undefined || owned.has(key)) {
      panic(`Transition metadata cannot set ${key}`);
    }
    if (value !== undefined) {
      assignments.push(
        sql`${sql.identifier(column.name)} = ${isSQLWrapper(value) ? value : sql.param(value, column)}`,
      );
    }
  }
  for (const [key, column] of Object.entries(columns)) {
    if (
      owned.has(key) ||
      Reflect.get(set, key) !== undefined ||
      column.onUpdateFn === undefined
    ) {
      continue;
    }
    const value = column.onUpdateFn();
    assignments.push(
      sql`${sql.identifier(column.name)} = ${isSQLWrapper(value) ? value : sql.param(value, column)}`,
    );
  }
  const fence = fenceKey === undefined ? undefined : columns[fenceKey];
  if (fenceKey !== undefined && expectedFence === undefined) {
    panic("The transition requires its declared fence");
  }
  if (fenceKey === undefined && expectedFence !== undefined) {
    panic("This transition table has no fence");
  }
  if (ids.length === 0) {
    return [];
  }
  const identityMatch =
    match === "one"
      ? sql`${identity.column} = ${sql.param(ids[0], identity.column)}`
      : sql`${identity.column} IN (${sql.join(
          ids.map((id) => sql`${sql.param(id, identity.column)}`),
          sql`, `,
        )})`;
  const sources = moves.map(
    ({ column, from }) =>
      sql`AND ${column} IN (${sql.join(
        from.map((value) => sql`${value}`),
        sql`, `,
      )})`,
  );
  const returned = moves.map(
    ({ key, column }) => sql`, ${column} AS ${sql.identifier(key)}`,
  );
  const rows = await tx.execute(sql`
    UPDATE ${table}
    SET ${sql.join(assignments, sql`, `)}
    WHERE ${identityMatch}
      ${sql.join(sources, sql` `)}
      ${fence === undefined ? sql`` : sql`AND ${fence} IS NOT DISTINCT FROM ${sql.param(expectedFence, fence)}`}
    RETURNING ${identity.column} AS "id"${sql.join(returned, sql``)}
  `);
  // Stale updates change nothing and record nothing.
  if (rows.length > 0) {
    await recordTransitionAuditEvent(rows);
  }
  return rows;
};

type StatusUpdateArgs = Pick<
  LifecycleUpdateArgs,
  "tx" | "identity" | "ids" | "match" | "recordTransitionAuditEvent"
> & {
  spec: TransitionSpec & { table: StatusTable };
  options: {
    from: readonly string[];
    to: string;
    set?: Readonly<Record<string, unknown>>;
  };
};

const statusUpdate = async ({
  tx,
  spec,
  identity,
  ids,
  match,
  options,
  recordTransitionAuditEvent,
}: StatusUpdateArgs) => {
  // Untyped callers still need fence validation when the generic excludes a fence.
  const runtimeOptions: { readonly fence?: unknown } = options;
  return await lifecycleUpdate({
    tx,
    table: spec.table,
    identity,
    ids,
    match,
    moves: [
      {
        key: "status",
        column: spec.table.status,
        edges: spec.edges,
        from: options.from,
        to: options.to,
      },
    ],
    set: options.set,
    fence: { key: spec.fence, value: runtimeOptions.fence },
    recordTransitionAuditEvent,
  });
};

/** The update and required audit share the caller's transaction. */
export const transition = async <
  TTx extends TransitionTransaction,
  TTable extends LifecycleTable,
  const TEdges extends Readonly<Record<string, readonly string[]>>,
  TOptions extends { terminal: readonly string[]; fence?: string },
>({
  tx,
  spec,
  id,
  options,
  recordTransitionAuditEvent,
}: TransitionArgs<TTx, TTable, TEdges, TOptions>): Promise<
  TransitionResult<GetColumnData<TTable["id"]>, Status<TTable>>
> => {
  // Column's runtime decoder erases its data type; restore its declared codec contract.
  const idDecoder: DriverValueDecoder<
    GetColumnData<TTable["id"]>,
    unknown
  > = spec.table.id;
  const statusDecoder: DriverValueDecoder<Status<TTable>, unknown> = spec.table
    .status;
  const decode = (row: Record<string, unknown>) => ({
    id: idDecoder.mapFromDriverValue(row["id"]),
    status: statusDecoder.mapFromDriverValue(row["status"]),
  });
  const rows = await statusUpdate({
    tx,
    spec,
    identity: { key: "id", column: spec.table.id },
    ids: [id],
    match: "one",
    options,
    recordTransitionAuditEvent: async ([changed]) => {
      await recordTransitionAuditEvent(
        tx,
        decode(changed ?? panic("A recorded transition has its row")),
      );
    },
  });
  const row = rows.at(0);
  if (row === undefined) {
    return { type: "stale" };
  }
  return { type: "transitioned", row: decode(row) } as const;
};

type TransitionBatchArgs<
  TTx extends TransitionTransaction,
  TTable extends StatusTable,
  TKey extends keyof TTable["_"]["columns"] & string,
  TEdges extends Readonly<Record<string, readonly string[]>>,
  TOptions extends { terminal: readonly string[]; fence?: string },
> = {
  tx: TTx;
  spec: TransitionSpec & {
    table: TTable;
    key: TKey;
    idColumn: TTable["_"]["columns"][TKey];
    edges: TEdges;
    options: TOptions;
  };
  ids: readonly GetColumnData<NoInfer<TTable>["_"]["columns"][NoInfer<TKey>]>[];
  options: Move<NoInfer<TEdges>> &
    Fence<NoInfer<TTable>, NoInfer<TOptions>> & {
      set?: Omit<
        PgUpdateSetSource<NoInfer<TTable>>,
        NoInfer<TKey> | TransitionOwnedKeys<NoInfer<TOptions>>
      > &
        Partial<
          Record<NoInfer<TKey> | TransitionOwnedKeys<NoInfer<TOptions>>, never>
        >;
    };
  recordTransitionAuditEvent: (
    tx: TTx,
    rows: readonly {
      id: GetColumnData<TTable["_"]["columns"][TKey]>;
      status: Status<TTable>;
    }[],
  ) => Promise<void>;
};

/** One conditional update per held batch; only changed rows reach its required audit. */
export const transitionBatch = async <
  TTx extends TransitionTransaction,
  TTable extends StatusTable,
  TKey extends keyof TTable["_"]["columns"] & string,
  const TEdges extends Readonly<Record<string, readonly string[]>>,
  TOptions extends { terminal: readonly string[]; fence?: string },
>({
  tx,
  spec,
  ids,
  options,
  recordTransitionAuditEvent,
}: TransitionBatchArgs<TTx, TTable, TKey, TEdges, TOptions>) => {
  const idDecoder: DriverValueDecoder<
    GetColumnData<TTable["_"]["columns"][TKey]>,
    unknown
  > = spec.idColumn;
  const statusDecoder: DriverValueDecoder<Status<TTable>, unknown> = spec.table
    .status;
  const decode = (rows: readonly Record<string, unknown>[]) =>
    rows.map((row) => ({
      id: idDecoder.mapFromDriverValue(row["id"]),
      status: statusDecoder.mapFromDriverValue(row["status"]),
    }));
  const rows = await statusUpdate({
    tx,
    spec,
    identity: { key: spec.key, column: spec.idColumn },
    ids,
    match: "many",
    options,
    recordTransitionAuditEvent: async (changed) => {
      await recordTransitionAuditEvent(tx, decode(changed));
    },
  });
  return decode(rows);
};

type ColumnKey<TTable extends PgTable> = keyof TTable["_"]["columns"] & string;
type ColumnState<
  TTable extends PgTable,
  TColumn extends ColumnKey<TTable>,
> = GetColumnData<TTable["_"]["columns"][TColumn]> & string;
type LifecycleGraphs<TTable extends PgTable> = {
  readonly [TColumn in ColumnKey<TTable>]?: {
    readonly edges: Readonly<
      Record<
        ColumnState<TTable, TColumn>,
        readonly ColumnState<TTable, TColumn>[]
      >
    >;
    readonly terminal: readonly ColumnState<TTable, TColumn>[];
  };
};

type LifecycleGraph = {
  readonly edges: Readonly<Record<string, readonly string[]>>;
  readonly terminal: readonly string[];
};

/** A declared multi-column lifecycle; the transition map binds its columns to the inventory. */
export type LifecycleSpec<TColumn extends string = string> = {
  readonly kind: "lifecycle";
  readonly table: PgTable;
  readonly graphs: Readonly<Record<TColumn, LifecycleGraph>>;
};

type DefineLifecycleArgs<
  TTable extends PgTable,
  TKey extends ColumnKey<TTable>,
  TGraphs extends LifecycleGraphs<TTable>,
> = { table: TTable; key: TKey; graphs: TGraphs };

/**
 * Rows whose lifecycle spans several columns that move together. Each column
 * keeps its own graph, and every transition names a move for each of them.
 */
export const defineLifecycle = <
  TTable extends PgTable,
  const TKey extends ColumnKey<TTable>,
  const TGraphs extends LifecycleGraphs<TTable>,
>({
  table,
  key,
  graphs,
}: DefineLifecycleArgs<TTable, TKey, TGraphs>) => {
  const columns = getColumns(table);
  const runtimeColumns: Readonly<Record<string, AnyPgColumn>> = columns;
  const declared = Object.entries<LifecycleGraph | undefined>(graphs);
  if (declared.length === 0) {
    panic("A lifecycle must declare at least one column");
  }
  for (const [column, graph] of declared) {
    const lifecycleColumn =
      runtimeColumns[column] ?? panic(`Unknown lifecycle column ${column}`);
    if (graph === undefined) {
      panic(`Lifecycle column ${column} has no graph`);
    }
    assertLifecycleGraph({
      column: lifecycleColumn,
      edges: graph.edges,
      terminal: graph.terminal,
    });
    for (const targets of Object.values(graph.edges)) {
      Object.freeze(targets);
    }
    Object.freeze(graph.edges);
    Object.freeze(graph.terminal);
    Object.freeze(graph);
  }
  assertTransitionIdentity(table, key);
  return Object.freeze({
    kind: "lifecycle",
    table,
    key,
    idColumn: columns[key],
    graphs: Object.freeze(graphs),
  } as const);
};

type DefinedLifecycle<
  TTable extends PgTable,
  TKey extends ColumnKey<TTable>,
  TGraphs extends LifecycleGraphs<TTable>,
> = {
  readonly kind: "lifecycle";
  readonly table: TTable;
  readonly key: TKey;
  readonly idColumn: TTable["_"]["columns"][TKey];
  readonly graphs: TGraphs;
};

type GraphEdges<TGraph> = TGraph extends {
  edges: infer TEdges extends Readonly<Record<string, readonly string[]>>;
}
  ? TEdges
  : never;

type LifecycleMoves<TGraphs> = {
  [TColumn in keyof TGraphs & string]: Move<GraphEdges<TGraphs[TColumn]>>;
};

/** Narrows a move computed at run time to one its column's graph permits. */
export const permitsLifecycleMove = <TGraph extends LifecycleGraph>(
  graph: TGraph,
  move: { readonly from: readonly string[]; readonly to: string },
): move is Move<GraphEdges<TGraph>> =>
  move.from.length > 0 &&
  move.from.every((from) => permitsTransition(graph, from, move.to));

type TransitionLifecycleArgs<
  TTx extends TransitionTransaction,
  TTable extends PgTable,
  TKey extends ColumnKey<TTable>,
  TGraphs extends LifecycleGraphs<TTable>,
> = {
  tx: TTx;
  spec: DefinedLifecycle<TTable, TKey, TGraphs>;
  moves: LifecycleMoves<NoInfer<TGraphs>>;
  set?: Omit<
    PgUpdateSetSource<NoInfer<TTable>>,
    NoInfer<TKey> | (keyof NoInfer<TGraphs> & string)
  > &
    Partial<Record<NoInfer<TKey> | (keyof NoInfer<TGraphs> & string), never>>;
};

type LifecycleMoveSet = Readonly<
  Record<string, { readonly from: readonly string[]; readonly to: string }>
>;

const lifecycleMoves = (
  { table, graphs }: { table: PgTable; graphs: object },
  moves: LifecycleMoveSet,
) => {
  const runtimeColumns: Readonly<Record<string, AnyPgColumn>> =
    getColumns(table);
  const declared = Object.entries<LifecycleGraph>(graphs);
  if (
    Object.keys(moves).some(
      (key) => !declared.some(([column]) => column === key),
    )
  ) {
    panic("A lifecycle move names an undeclared column");
  }
  return declared.map(([key, { edges }]) => {
    const move = moves[key] ?? panic(`The transition must move ${key}`);
    return {
      key,
      column: runtimeColumns[key] ?? panic(`Unknown lifecycle column ${key}`),
      edges,
      from: move.from,
      to: move.to,
    };
  });
};

/** Moves every declared lifecycle column of one row; the audit shares the transaction. */
export const transitionLifecycle = async <
  TTx extends TransitionTransaction,
  TTable extends PgTable,
  TKey extends ColumnKey<TTable>,
  const TGraphs extends LifecycleGraphs<TTable>,
>({
  tx,
  spec,
  id,
  moves,
  set,
  recordTransitionAuditEvent,
}: TransitionLifecycleArgs<TTx, TTable, TKey, TGraphs> & {
  id: GetColumnData<TTable["_"]["columns"][TKey]>;
  recordTransitionAuditEvent: (
    tx: TTx,
    row: {
      id: GetColumnData<TTable["_"]["columns"][TKey]>;
      moves: LifecycleMoves<TGraphs>;
    },
  ) => Promise<void>;
}): Promise<
  | { type: "transitioned"; id: GetColumnData<TTable["_"]["columns"][TKey]> }
  | { type: "stale" }
> => {
  const idDecoder: DriverValueDecoder<
    GetColumnData<TTable["_"]["columns"][TKey]>,
    unknown
  > = spec.idColumn;
  const rows = await lifecycleUpdate({
    tx,
    table: spec.table,
    identity: { key: spec.key, column: spec.idColumn },
    ids: [id],
    match: "one",
    moves: lifecycleMoves(spec, moves),
    set,
    fence: { key: undefined, value: undefined },
    recordTransitionAuditEvent: async ([changed]) => {
      await recordTransitionAuditEvent(tx, {
        id: idDecoder.mapFromDriverValue(
          (changed ?? panic("A recorded transition has its row"))["id"],
        ),
        moves,
      });
    },
  });
  const row = rows.at(0);
  if (row === undefined) {
    return { type: "stale" };
  }
  return { type: "transitioned", id: idDecoder.mapFromDriverValue(row["id"]) };
};

/** One conditional update moving every declared column; only changed rows reach the audit. */
export const transitionLifecycleBatch = async <
  TTx extends TransitionTransaction,
  TTable extends PgTable,
  TKey extends ColumnKey<TTable>,
  const TGraphs extends LifecycleGraphs<TTable>,
>({
  tx,
  spec,
  ids,
  moves,
  set,
  recordTransitionAuditEvent,
}: TransitionLifecycleArgs<TTx, TTable, TKey, TGraphs> & {
  ids: readonly GetColumnData<NoInfer<TTable>["_"]["columns"][NoInfer<TKey>]>[];
  recordTransitionAuditEvent: (
    tx: TTx,
    changed: {
      ids: readonly GetColumnData<TTable["_"]["columns"][TKey]>[];
      moves: LifecycleMoves<TGraphs>;
    },
  ) => Promise<void>;
}) => {
  const idDecoder: DriverValueDecoder<
    GetColumnData<TTable["_"]["columns"][TKey]>,
    unknown
  > = spec.idColumn;
  const decode = (rows: readonly Record<string, unknown>[]) =>
    rows.map((row) => idDecoder.mapFromDriverValue(row["id"]));
  const rows = await lifecycleUpdate({
    tx,
    table: spec.table,
    identity: { key: spec.key, column: spec.idColumn },
    ids,
    match: "many",
    moves: lifecycleMoves(spec, moves),
    set,
    fence: { key: undefined, value: undefined },
    recordTransitionAuditEvent: async (changed) => {
      await recordTransitionAuditEvent(tx, { ids: decode(changed), moves });
    },
  });
  return decode(rows);
};

/** A lifecycle column written once at insert; the map binds it to the inventory. */
export type FixedLifecycleSpec<TColumn extends string = string> = {
  readonly kind: "fixed";
  readonly table: PgTable;
  readonly column: TColumn;
  readonly value: string;
};

/**
 * A lifecycle column set once at insert and never updated. It has no
 * transitions to run, so any update of the column remains a direct write.
 */
export const defineFixedLifecycle = <
  TTable extends PgTable,
  const TColumn extends ColumnKey<TTable>,
  const TValue extends ColumnState<TTable, TColumn>,
>({
  table,
  column,
  value,
}: {
  table: TTable;
  column: TColumn;
  value: TValue;
}) => {
  if (!Object.hasOwn(getColumns(table), column)) {
    panic(`Unknown lifecycle column ${column}`);
  }
  return Object.freeze({ kind: "fixed", table, column, value } as const);
};
