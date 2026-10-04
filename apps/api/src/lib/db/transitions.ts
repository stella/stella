import { panic } from "better-result";
import { getColumns, isSQLWrapper, sql } from "drizzle-orm";
import type { DriverValueDecoder, GetColumnData, SQL } from "drizzle-orm";
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
  const statuses = table.status.enumValues;
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
      options.terminal.some((status) => status === from) &&
      targets.some((to) => to !== from)
    ) {
      panic(`Terminal status ${from} cannot have outgoing transitions`);
    }
  }
  if (options.terminal.some((status) => !Object.hasOwn(edges, status))) {
    panic("Unknown terminal status");
  }
  if (
    options.fence !== undefined &&
    !Object.hasOwn(getColumns(table), options.fence)
  ) {
    panic("The declared transition fence is not a table column");
  }
  if (idColumn === undefined || !idColumn.primary) {
    panic("A transition identity must be a primary-key column");
  }
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

type TransitionAssignmentsArgs = {
  spec: TransitionSpec;
  key: string;
  options: {
    from: readonly string[];
    to: string;
    set?: Readonly<Record<string, unknown>>;
    fence?: unknown;
  };
};

const transitionAssignments = ({
  spec,
  key: identityKey,
  options,
}: TransitionAssignmentsArgs) => {
  if (
    options.from.length === 0 ||
    options.from.some((from) => !permitsTransition(spec, from, options.to))
  ) {
    panic("Illegal status transition");
  }
  const columns = getColumns(spec.table);
  const assignments = [
    sql`${sql.identifier(spec.table.status.name)} = ${options.to}`,
  ];
  const metadata: Readonly<Record<string, unknown>> = options.set ?? {};
  for (const [key, value] of Object.entries(metadata)) {
    const column = columns[key];
    if (
      column === undefined ||
      key === identityKey ||
      key === "status" ||
      key === spec.fence
    ) {
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
      key === identityKey ||
      key === "status" ||
      key === spec.fence ||
      Reflect.get(options.set ?? {}, key) !== undefined ||
      column.onUpdateFn === undefined
    ) {
      continue;
    }
    const value = column.onUpdateFn();
    assignments.push(
      sql`${sql.identifier(column.name)} = ${isSQLWrapper(value) ? value : sql.param(value, column)}`,
    );
  }
  const fence = spec.fence === undefined ? undefined : columns[spec.fence];
  // Untyped callers still need fence validation when the generic excludes a fence.
  const runtimeOptions: { readonly fence?: unknown } = options;
  const expectedFence = runtimeOptions.fence;
  if (spec.fence !== undefined && expectedFence === undefined) {
    panic("The transition requires its declared fence");
  }
  if (spec.fence === undefined && expectedFence !== undefined) {
    panic("This transition table has no fence");
  }
  return { assignments, fence };
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
  const { assignments, fence } = transitionAssignments({
    spec,
    key: "id",
    options,
  });
  const rows = await tx.execute(sql`
    UPDATE ${spec.table}
    SET ${sql.join(assignments, sql`, `)}
    WHERE ${spec.table.id} = ${sql.param(id, spec.table.id)}
      AND ${spec.table.status} IN (${sql.join(
        options.from.map((from) => sql`${from}`),
        sql`, `,
      )})
      ${fence === undefined ? sql`` : sql`AND ${fence} IS NOT DISTINCT FROM ${sql.param(options.fence, fence)}`}
    RETURNING ${spec.table.id} AS "id", ${spec.table.status} AS "status"
  `);
  const row = rows.at(0);
  if (row === undefined) {
    return { type: "stale" };
  }
  // Column's runtime decoder erases its data type; restore its declared codec contract.
  const idDecoder: DriverValueDecoder<
    GetColumnData<TTable["id"]>,
    unknown
  > = spec.table.id;
  const statusDecoder: DriverValueDecoder<Status<TTable>, unknown> = spec.table
    .status;
  const transitioned = {
    type: "transitioned",
    row: {
      id: idDecoder.mapFromDriverValue(row["id"]),
      status: statusDecoder.mapFromDriverValue(row["status"]),
    },
  } as const;
  await recordTransitionAuditEvent(tx, transitioned.row);
  return transitioned;
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
  const { assignments, fence } = transitionAssignments({
    spec,
    key: spec.key,
    options,
  });
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx.execute(sql`
    UPDATE ${spec.table}
    SET ${sql.join(assignments, sql`, `)}
    WHERE ${spec.idColumn} IN (${sql.join(
      ids.map((id) => sql`${sql.param(id, spec.idColumn)}`),
      sql`, `,
    )})
      AND ${spec.table.status} IN (${sql.join(
        options.from.map((from) => sql`${from}`),
        sql`, `,
      )})
      ${fence === undefined ? sql`` : sql`AND ${fence} IS NOT DISTINCT FROM ${sql.param(options.fence, fence)}`}
    RETURNING ${spec.idColumn} AS "id", ${spec.table.status} AS "status"
  `);
  const idDecoder: DriverValueDecoder<
    GetColumnData<TTable["_"]["columns"][TKey]>,
    unknown
  > = spec.idColumn;
  const statusDecoder: DriverValueDecoder<Status<TTable>, unknown> = spec.table
    .status;
  const changed = rows.map((row) => ({
    id: idDecoder.mapFromDriverValue(row["id"]),
    status: statusDecoder.mapFromDriverValue(row["status"]),
  }));
  if (changed.length > 0) {
    await recordTransitionAuditEvent(tx, changed);
  }
  return changed;
};
