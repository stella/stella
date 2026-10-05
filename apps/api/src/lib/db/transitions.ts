import { panic } from "better-result";
import { getColumns, isSQLWrapper, sql } from "drizzle-orm";
import type { DriverValueDecoder, GetColumnData, SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type {
  AnyPgColumn,
  PgTable,
  PgInsertValue,
  PgUpdateSetSource,
} from "drizzle-orm/pg-core";

type StatusTable = PgTable & { status: AnyPgColumn };
type LifecycleTable = StatusTable & { id: AnyPgColumn };
type Status<TTable extends StatusTable> = GetColumnData<TTable["status"]> &
  string;
type FenceKey<TTable extends StatusTable> = Extract<
  keyof TTable["_"]["columns"],
  "leaseToken" | "attempt" | "claimedAt" | "generation"
>;

export type TransitionSpec = {
  readonly table: PgTable;
  readonly edges: Readonly<Record<string, readonly string[]>>;
  readonly terminal: readonly string[];
  readonly fence: string | undefined;
  readonly scope?: readonly string[] | undefined;
};

type ScopedStateTable = PgTable;
type ColumnKey<TTable extends ScopedStateTable> = keyof TTable["_"]["columns"] &
  string;
type StateValue<
  TTable extends ScopedStateTable,
  TState extends ColumnKey<TTable>,
> = GetColumnData<TTable["_"]["columns"][TState]> & string;

export type ScopedTransitionSpec<
  TTable extends ScopedStateTable,
  TKey extends ColumnKey<TTable>,
  TScope extends readonly ColumnKey<TTable>[],
  TState extends ColumnKey<TTable>,
  TEdges extends Readonly<
    Record<StateValue<TTable, TState>, readonly StateValue<TTable, TState>[]>
  >,
> = ScopedTransitionDeclaration & {
  readonly table: TTable;
  readonly key: TKey;
  readonly scope: TScope;
  readonly stateColumn: TState;
  readonly edges: TEdges;
  readonly initial: readonly StateValue<TTable, TState>[];
  readonly sameStateUpsert: "ignore" | "update" | undefined;
};

export type ScopedTransitionDeclaration = {
  readonly table: PgTable;
  readonly key: string;
  readonly scope: readonly string[];
  readonly stateColumn: string;
  readonly edges: Readonly<Record<string, readonly string[]>>;
  readonly initial: readonly string[];
  readonly sameStateUpsert: "ignore" | "update" | undefined;
};

/** Declares a lifecycle over a real (possibly composite) primary key. */
export const defineScopedTransitions = <
  TTable extends ScopedStateTable,
  const TKey extends ColumnKey<TTable>,
  const TScope extends readonly ColumnKey<TTable>[],
  const TState extends ColumnKey<TTable>,
  const TEdges extends Readonly<
    Record<StateValue<TTable, TState>, readonly StateValue<TTable, TState>[]>
  >,
>({
  table,
  key,
  scope,
  stateColumn,
  edges,
  initial,
  sameStateUpsert,
}: {
  table: TTable;
  key: TKey;
  scope: TScope;
  stateColumn: TState;
  edges: TEdges;
  initial: readonly StateValue<TTable, TState>[];
  sameStateUpsert?: "ignore" | "update";
}): ScopedTransitionSpec<TTable, TKey, TScope, TState, TEdges> => {
  const columns: Readonly<Record<string, AnyPgColumn>> = getColumns(table);
  const state = columns[stateColumn];
  const keyColumn = columns[key];
  const keyNames = [key, ...scope];
  const keyColumns = keyNames.map((name) => columns[name]);
  if (state?.enumValues === undefined || keyColumn === undefined) {
    panic("A scoped transition requires an enum state and identity columns");
  }
  const stateValues = state.enumValues;
  const tableConfig = getTableConfig(table);
  const uniqueIdentityCovered = [
    ...tableConfig.primaryKeys,
    ...tableConfig.uniqueConstraints,
  ].some(
    ({ columns: primary }) =>
      primary.length === keyColumns.length &&
      primary.every((column) =>
        keyColumns.some((candidate) => candidate?.name === column.name),
      ),
  );
  if (
    new Set(keyNames).size !== keyNames.length ||
    keyColumns.some((column) => column === undefined || !column.notNull) ||
    (!(scope.length === 0 && (keyColumn.primary || keyColumn.isUnique)) &&
      !uniqueIdentityCovered)
  ) {
    panic(
      "A scoped transition identity must cover exactly one non-null primary or unique key",
    );
  }
  if (
    stateValues.some((value) => !Object.hasOwn(edges, value)) ||
    Object.keys(edges).some((value) => !stateValues.includes(value)) ||
    initial.some((value) => !stateValues.includes(value))
  ) {
    panic("A scoped transition graph must cover its closed state domain");
  }
  for (const [from, targets] of Object.entries<readonly string[]>(edges)) {
    if (targets.some((to) => !stateValues.includes(to))) {
      panic(`Unknown scoped transition target from ${from}`);
    }
  }
  return Object.freeze({
    table,
    key,
    scope,
    stateColumn,
    edges: Object.freeze(edges),
    initial: Object.freeze([...initial]),
    sameStateUpsert,
  });
};

type ScopedIdentity<
  TTable extends ScopedStateTable,
  TKey extends ColumnKey<TTable>,
  TScope extends readonly ColumnKey<TTable>[],
> = {
  [K in TKey | TScope[number]]: GetColumnData<TTable["_"]["columns"][K]>;
};

type ScopedChangedRow<
  TTable extends ScopedStateTable,
  TState extends ColumnKey<TTable>,
> = {
  identity: Readonly<Record<string, unknown>>;
  status: StateValue<TTable, TState>;
};

type ScopedUpsertRow<
  TTable extends ScopedStateTable,
  TKey extends ColumnKey<TTable>,
  TScope extends readonly ColumnKey<TTable>[],
  TState extends ColumnKey<TTable>,
> = PgInsertValue<TTable> & {
  [K in TKey | TScope[number] | TState]-?: GetColumnData<
    TTable["_"]["columns"][K]
  >;
};

type ScopedInsertKey<TTable extends ScopedStateTable> = Extract<
  ColumnKey<TTable>,
  keyof PgInsertValue<TTable>
>;

const ignoreTransitionAudit = async (): Promise<void> => {
  await Promise.resolve();
};

const typedColumnParam = (value: unknown, column: AnyPgColumn) =>
  sql`${sql.param(value, column)}::${sql.raw(column.getSQLType())}`;

const isScopedStateValue = <
  TTable extends ScopedStateTable,
  TState extends ColumnKey<TTable>,
>(
  table: TTable,
  stateColumn: TState,
  value: unknown,
): value is StateValue<TTable, TState> => {
  const column = getColumns(table)[stateColumn];
  return (
    typeof value === "string" && column?.enumValues?.includes(value) === true
  );
};

type ScopedUpsertWriteArgs<
  TTx extends TransitionTransaction,
  TTable extends ScopedStateTable,
  TKey extends ScopedInsertKey<TTable>,
  TScope extends readonly ScopedInsertKey<TTable>[],
  TState extends ScopedInsertKey<TTable>,
  TEdges extends Readonly<Record<string, readonly string[]>>,
> = {
  tx: TTx;
  spec: ScopedTransitionSpec<TTable, TKey, TScope, TState, TEdges>;
  values: readonly ScopedUpsertRow<TTable, TKey, TScope, TState>[];
  state: AnyPgColumn;
  insertColumns: readonly AnyPgColumn[];
  identityKeys: readonly (TKey | TScope[number])[];
  identityColumns: readonly AnyPgColumn[];
  incomingRows: SQL;
  recordTransitionAuditEvent: (
    tx: TTx,
    rows: readonly ScopedChangedRow<TTable, TState>[],
  ) => void | Promise<void>;
};

const executeScopedUpsertWrites = async <
  TTx extends TransitionTransaction,
  TTable extends ScopedStateTable,
  TKey extends ScopedInsertKey<TTable>,
  TScope extends readonly ScopedInsertKey<TTable>[],
  TState extends ScopedInsertKey<TTable>,
  const TEdges extends Readonly<
    Record<StateValue<TTable, TState>, readonly StateValue<TTable, TState>[]>
  >,
>({
  tx,
  spec,
  values,
  state,
  insertColumns,
  identityKeys,
  identityColumns,
  incomingRows,
  recordTransitionAuditEvent,
}: ScopedUpsertWriteArgs<TTx, TTable, TKey, TScope, TState, TEdges>) => {
  const returning = sql.join(
    [
      ...identityColumns.map((column, index) => {
        const key = identityKeys[index];
        if (key === undefined) {
          panic("Declared identity key is missing");
        }
        return sql`${sql.identifier(column.name)} AS ${sql.identifier(key)}`;
      }),
      sql`${sql.identifier(state.name)} AS "status"`,
    ],
    sql`, `,
  );
  const returningUpdated = sql.join(
    [
      ...identityColumns.map((column, index) => {
        const key = identityKeys[index];
        if (key === undefined) {
          panic("Declared identity key is missing");
        }
        return sql`current.${sql.identifier(column.name)} AS ${sql.identifier(key)}`;
      }),
      sql`current.${sql.identifier(state.name)} AS "status"`,
    ],
    sql`, `,
  );
  const insertRows =
    spec.initial.length === 0
      ? []
      : await tx.execute(sql`
          INSERT INTO ${spec.table} (${sql.join(
            insertColumns.map((column) => sql.identifier(column.name)),
            sql`, `,
          )})
          SELECT ${sql.join(
            insertColumns.map(
              (column) => sql`incoming.${sql.identifier(column.name)}`,
            ),
            sql`, `,
          )}
          FROM (VALUES ${incomingRows}) AS incoming (${sql.join(
            insertColumns.map((column) => sql.identifier(column.name)),
            sql`, `,
          )})
          WHERE incoming.${sql.identifier(state.name)} IN (${sql.join(
            spec.initial.map((initial) => sql`${sql.param(initial, state)}`),
            sql`, `,
          )})
          ON CONFLICT (${sql.join(
            identityColumns.map((column) => sql.identifier(column.name)),
            sql`, `,
          )}) DO NOTHING
          RETURNING ${returning}
        `);
  const columns: Readonly<Record<string, AnyPgColumn>> = getColumns(spec.table);
  const primaryColumns = new Set(
    getTableConfig(spec.table).primaryKeys.flatMap(({ columns: primary }) =>
      primary.map((column) => column.name),
    ),
  );
  const updateColumns = insertColumns.filter(
    (column) =>
      !column.primary &&
      !primaryColumns.has(column.name) &&
      !identityKeys.some((key) => columns[key]?.name === column.name),
  );
  const priorStates = Object.entries<readonly string[]>(spec.edges).flatMap(
    ([from, targets]) =>
      targets.some((target) =>
        values.some((row) => row[spec.stateColumn] === target),
      )
        ? [from]
        : [],
  );
  const transitionRows =
    priorStates.length === 0
      ? []
      : await tx.execute(sql`
          UPDATE ${spec.table} AS current
          SET ${sql.join(
            updateColumns.map(
              (column) =>
                sql`${sql.identifier(column.name)} = incoming.${sql.identifier(column.name)}`,
            ),
            sql`, `,
          )}
          FROM (VALUES ${incomingRows}) AS incoming (${sql.join(
            insertColumns.map((column) => sql.identifier(column.name)),
            sql`, `,
          )})
          WHERE ${sql.join(
            identityColumns.map(
              (column) =>
                sql`current.${sql.identifier(column.name)} = incoming.${sql.identifier(column.name)}`,
            ),
            sql` AND `,
          )}
            AND current.${sql.identifier(state.name)} <> incoming.${sql.identifier(state.name)}
            AND (${sql.join(
              Object.entries<readonly string[]>(spec.edges).flatMap(
                ([from, targets]) =>
                  targets.map(
                    (to) =>
                      sql`(current.${sql.identifier(state.name)} = ${sql.param(from, state)} AND incoming.${sql.identifier(state.name)} = ${sql.param(to, state)})`,
                  ),
              ),
              sql` OR `,
            )})
          RETURNING ${returningUpdated}
        `);
  if (spec.sameStateUpsert === "update" && updateColumns.length > 0) {
    await tx.execute(sql`
      UPDATE ${spec.table} AS current
      SET ${sql.join(
        updateColumns.map(
          (column) =>
            sql`${sql.identifier(column.name)} = incoming.${sql.identifier(column.name)}`,
        ),
        sql`, `,
      )}
      FROM (VALUES ${incomingRows}) AS incoming (${sql.join(
        insertColumns.map((column) => sql.identifier(column.name)),
        sql`, `,
      )})
      WHERE ${sql.join(
        identityColumns.map(
          (column) =>
            sql`current.${sql.identifier(column.name)} = incoming.${sql.identifier(column.name)}`,
        ),
        sql` AND `,
      )}
        AND current.${sql.identifier(state.name)} = incoming.${sql.identifier(state.name)}
    `);
  }
  const verified = await tx.execute(sql`
    SELECT 1
    FROM ${spec.table} AS current
    JOIN (VALUES ${incomingRows}) AS incoming (${sql.join(
      insertColumns.map((column) => sql.identifier(column.name)),
      sql`, `,
    )})
      ON ${sql.join(
        identityColumns.map(
          (column) =>
            sql`current.${sql.identifier(column.name)} = incoming.${sql.identifier(column.name)}`,
        ),
        sql` AND `,
      )}
    WHERE current.${sql.identifier(state.name)} = incoming.${sql.identifier(state.name)}
  `);
  if (verified.length !== values.length) {
    panic(
      "An upsert target is neither initial nor reachable from its current state",
    );
  }
  const changedRows = [...insertRows, ...transitionRows].map((row) => {
    const status = row["status"];
    if (!isScopedStateValue(spec.table, spec.stateColumn, status)) {
      panic("Upsert result returned an unknown state");
    }
    return {
      identity: Object.fromEntries(identityKeys.map((key) => [key, row[key]])),
      status,
    };
  });
  if (
    spec.sameStateUpsert === undefined &&
    changedRows.length !== values.length
  ) {
    panic("A same-state upsert requires an explicit policy");
  }
  if (changedRows.length > 0) {
    await recordTransitionAuditEvent(tx, changedRows);
  }
  return changedRows;
};

type ScopedMove<TEdges extends Readonly<Record<string, readonly string[]>>> = {
  [TTarget in keyof TEdges & string]: {
    to: TTarget;
    from: readonly [
      {
        [
          TSource in keyof TEdges & string
        ]: TTarget extends TEdges[TSource][number] ? TSource : never;
      }[keyof TEdges & string],
      ...{
        [
          TSource in keyof TEdges & string
        ]: TTarget extends TEdges[TSource][number] ? TSource : never;
      }[keyof TEdges & string][],
    ];
  };
}[keyof TEdges & string];

type ScopedTransitionWriteOptions = {
  from: readonly string[];
  to: string;
  set?: Readonly<Record<string, unknown>>;
};

const scopedTransitionAssignments = (
  spec: ScopedTransitionDeclaration,
  options: ScopedTransitionWriteOptions,
) => {
  const columns: Readonly<Record<string, AnyPgColumn>> = getColumns(spec.table);
  const state = columns[spec.stateColumn];
  if (state === undefined) {
    panic("Declared transition state column is missing");
  }
  if (
    options.from.length === 0 ||
    options.from.some((from) => spec.edges[from]?.includes(options.to) !== true)
  ) {
    panic("Illegal scoped transition");
  }
  const assignments = [
    sql`${sql.identifier(state.name)} = ${sql.param(options.to, state)}`,
  ];
  const reserved = new Set([spec.key, ...spec.scope, spec.stateColumn]);
  for (const [name, value] of Object.entries(options.set ?? {})) {
    const column = columns[name];
    if (column === undefined || reserved.has(name)) {
      panic(`Transition metadata cannot set ${name}`);
    }
    if (value !== undefined) {
      assignments.push(
        sql`${sql.identifier(column.name)} = ${isSQLWrapper(value) ? value : sql.param(value, column)}`,
      );
    }
  }
  return { state, assignments, columns };
};

/** Set-based transitions return only a count, keeping large scoped changes out of JS memory. */
export const transitionScopedCount = async <
  TTx extends TransitionTransaction,
  TTable extends ScopedStateTable,
  TKey extends ColumnKey<TTable>,
  TScope extends readonly ColumnKey<TTable>[],
  TState extends ColumnKey<TTable>,
  const TEdges extends Readonly<
    Record<StateValue<TTable, TState>, readonly StateValue<TTable, TState>[]>
  >,
>({
  tx,
  spec,
  where,
  options,
  recordTransitionAuditEvent,
}: {
  tx: TTx;
  spec: ScopedTransitionSpec<TTable, TKey, TScope, TState, TEdges>;
  where: SQL;
  options: ScopedMove<TEdges> & { set?: Readonly<Record<string, unknown>> };
  recordTransitionAuditEvent: (tx: TTx, count: number) => void | Promise<void>;
}) => {
  const { state, assignments } = scopedTransitionAssignments(spec, options);
  const rows = await tx.execute(sql`
    WITH changed AS (
      UPDATE ${spec.table}
      SET ${sql.join(assignments, sql`, `)}
      WHERE ${where}
        AND ${state} IN (${sql.join(
          options.from.map((from) => sql`${sql.param(from, state)}`),
          sql`, `,
        )})
      RETURNING 1
    )
    SELECT count(*)::double precision AS count FROM changed
  `);
  const count = rows.at(0)?.["count"];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    panic("Transition count returned an invalid aggregate");
  }
  if (count > 0) {
    await recordTransitionAuditEvent(tx, count);
  }
  return count;
};

/** One UPDATE handles a bounded set of complete composite identities. */
export const transitionScopedBatch = async <
  TTx extends TransitionTransaction,
  TTable extends ScopedStateTable,
  TKey extends ColumnKey<TTable>,
  TScope extends readonly ColumnKey<TTable>[],
  TState extends ColumnKey<TTable>,
  const TEdges extends Readonly<
    Record<StateValue<TTable, TState>, readonly StateValue<TTable, TState>[]>
  >,
>({
  tx,
  spec,
  identities,
  options,
  recordTransitionAuditEvent,
}: {
  tx: TTx;
  spec: ScopedTransitionSpec<TTable, TKey, TScope, TState, TEdges>;
  identities: readonly ScopedIdentity<TTable, TKey, TScope>[];
  options: ScopedMove<TEdges> & { set?: Readonly<Record<string, unknown>> };
  recordTransitionAuditEvent: (
    tx: TTx,
    rows: readonly {
      identity: Readonly<Record<string, unknown>>;
      status: StateValue<TTable, TState>;
    }[],
  ) => void | Promise<void>;
}) => {
  const { table } = spec;
  if (
    identities.some((identity) =>
      [spec.key, ...spec.scope].some((key) => !Object.hasOwn(identity, key)),
    )
  ) {
    panic("A scoped transition identity is incomplete");
  }
  const { state, assignments, columns } = scopedTransitionAssignments(
    spec,
    options,
  );
  if (identities.length === 0) {
    return [];
  }
  const identityKeys: readonly (TKey | TScope[number])[] = [
    spec.key,
    ...spec.scope,
  ];
  const identityColumns = identityKeys.map((key) => {
    const column = columns[key];
    if (column === undefined) {
      panic("Declared identity column is missing");
    }
    return column;
  });
  const identityPredicates = identities.map(
    (identity) =>
      sql`(${sql.join(
        identityKeys.map((key, index) => {
          const column = identityColumns[index];
          if (column === undefined) {
            panic("Declared identity column is missing");
          }
          return sql`${column} = ${sql.param(identity[key], column)}`;
        }),
        sql` AND `,
      )})`,
  );
  const rows = await tx.execute(sql`
    UPDATE ${table}
    SET ${sql.join(assignments, sql`, `)}
    WHERE (${sql.join(identityPredicates, sql` OR `)})
      AND ${state} IN (${sql.join(
        options.from.map((from) => sql`${from}`),
        sql`, `,
      )})
    RETURNING ${sql.join(
      [
        ...identityColumns.map((column, index) => {
          const key = identityKeys[index];
          if (key === undefined) {
            panic("Declared identity key is missing");
          }
          return sql`${column} AS ${sql.identifier(key)}`;
        }),
        sql`${state} AS "status"`,
      ],
      sql`, `,
    )}
  `);
  const changed = rows.map((row) => {
    const status = row["status"];
    if (!isScopedStateValue(table, spec.stateColumn, status)) {
      panic("Transition result returned an unknown state");
    }
    return {
      identity: Object.fromEntries(identityKeys.map((key) => [key, row[key]])),
      status,
    };
  });
  if (changed.length > 0) {
    await recordTransitionAuditEvent(tx, changed);
  }
  return changed;
};

/** Inserts declared initial states and audits real state changes once per batch. */
export const transitionUpsertBatch = async <
  TTx extends TransitionTransaction,
  TTable extends ScopedStateTable,
  TKey extends ScopedInsertKey<TTable>,
  TScope extends readonly ScopedInsertKey<TTable>[],
  TState extends ScopedInsertKey<TTable>,
  const TEdges extends Readonly<
    Record<StateValue<TTable, TState>, readonly StateValue<TTable, TState>[]>
  >,
>({
  tx,
  spec,
  values,
  recordTransitionAuditEvent,
}: {
  tx: TTx;
  spec: ScopedTransitionSpec<TTable, TKey, TScope, TState, TEdges>;
  values: readonly ScopedUpsertRow<TTable, TKey, TScope, TState>[];
  recordTransitionAuditEvent: (
    tx: TTx,
    rows: readonly ScopedChangedRow<TTable, TState>[],
  ) => void | Promise<void>;
}): Promise<ScopedChangedRow<TTable, TState>[]> => {
  if (values.length === 0) {
    return [];
  }
  const identityKeys: readonly (TKey | TScope[number])[] = [
    spec.key,
    ...spec.scope,
  ];
  const seenIdentities = new Set<string>();
  for (const row of values) {
    if (identityKeys.some((key) => row[key] === undefined)) {
      panic("An upsert must include every identity column");
    }
    const identity = JSON.stringify(identityKeys.map((key) => row[key]));
    if (seenIdentities.has(identity)) {
      panic("An upsert batch contains duplicate identities");
    }
    seenIdentities.add(identity);
  }
  if (values.length > 128) {
    const changedRows: ScopedChangedRow<TTable, TState>[] = [];
    for (let offset = 0; offset < values.length; offset += 128) {
      changedRows.push(
        ...(await transitionUpsertBatch({
          tx,
          spec,
          values: values.slice(offset, offset + 128),
          recordTransitionAuditEvent: ignoreTransitionAudit,
        })),
      );
    }
    if (changedRows.length > 0) {
      await recordTransitionAuditEvent(tx, changedRows);
    }
    return changedRows;
  }
  const columns: Readonly<Record<string, AnyPgColumn>> = getColumns(spec.table);
  const state = columns[spec.stateColumn];
  if (state === undefined) {
    panic("Declared transition state column is missing");
  }
  const firstValue = values.at(0) ?? panic("Upsert batch unexpectedly empty");
  const valueKeys = Object.keys(firstValue).filter(
    (key): key is ScopedInsertKey<TTable> => Object.hasOwn(columns, key),
  );
  const insertColumns = valueKeys.map((key) => {
    const column = columns[key];
    if (column === undefined) {
      panic(`Upsert value ${key} is not a table column`);
    }
    return column;
  });
  if (
    !identityKeys.every((key) => valueKeys.includes(key)) ||
    !Object.hasOwn(firstValue, spec.stateColumn)
  ) {
    panic("An upsert must include every identity and its declared state");
  }
  for (const row of values) {
    if (
      valueKeys.length !== Object.keys(row).length ||
      valueKeys.some(
        (key) => !Object.hasOwn(row, key) || row[key] === undefined,
      )
    ) {
      panic("Every upsert row must provide the same complete column set");
    }
    const incomingState = row[spec.stateColumn];
    if (
      typeof incomingState !== "string" ||
      !state.enumValues?.includes(incomingState)
    ) {
      panic("An upsert state must belong to the declared lifecycle domain");
    }
  }
  const incomingRows = sql.join(
    values.map(
      (row) =>
        sql`(${sql.join(
          insertColumns.map((column, index) => {
            const key = valueKeys[index];
            if (key === undefined) {
              panic("Upsert column key is missing");
            }
            const value = row[key];
            return typedColumnParam(value, column);
          }),
          sql`, `,
        )})`,
    ),
    sql`, `,
  );
  const identityColumns = identityKeys.map((key) => {
    const column = columns[key];
    if (column === undefined) {
      panic("Declared identity column is missing");
    }
    return column;
  });
  const changedRows = await executeScopedUpsertWrites({
    tx,
    spec,
    values,
    state,
    insertColumns,
    identityKeys,
    identityColumns,
    incomingRows,
    recordTransitionAuditEvent: ignoreTransitionAudit,
  });
  if (changedRows.length > 0) {
    await recordTransitionAuditEvent(tx, changedRows);
  }
  return changedRows;
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
  TScope extends readonly (keyof TTable["_"]["columns"] & string)[] | undefined,
> = {
  table: TTable;
  key: TKey;
  edges: TEdges;
  options: TOptions;
  scope?: TScope;
};

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
  const TScope extends
    | readonly (keyof TTable["_"]["columns"] & string)[]
    | undefined = undefined,
>({
  table,
  key,
  edges,
  options,
  scope,
}: DefineKeyedTransitionsArgs<TTable, TKey, TEdges, TOptions, TScope>) => {
  const idColumn = getColumns(table)[key];
  // Runtime callers can supply keys outside the generic column domain.
  const runtimeColumns: Readonly<Record<string, AnyPgColumn>> =
    getColumns(table);
  const runtimeIdColumn = runtimeColumns[key];
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
  if (runtimeIdColumn === undefined) {
    panic("A transition identity must be a table column");
  }
  if (scope === undefined) {
    if (!runtimeIdColumn.primary) {
      panic("A transition identity must be a primary-key column");
    }
  } else {
    const keys = [key, ...scope];
    const columns = keys.map((name) => runtimeColumns[name]);
    if (
      scope.length === 0 ||
      new Set(keys).size !== keys.length ||
      !getTableConfig(table).primaryKeys.some(
        ({ columns: primary }) =>
          primary.length === columns.length &&
          primary.every((column) =>
            columns.some((candidate) => candidate?.name === column.name),
          ),
      )
    ) {
      panic(
        "A scoped transition identity must cover exactly one composite primary key",
      );
    }
  }
  for (const targets of Object.values<readonly string[]>(edges)) {
    Object.freeze(targets);
  }
  return Object.freeze({
    table,
    key,
    idColumn,
    scope,
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
  ? {
      fence: GetColumnData<TTable["_"]["columns"][TKey]>;
      nextFence?: GetColumnData<TTable["_"]["columns"][TKey]>;
    }
  : { fence?: never; nextFence?: never };

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

type TransitionAssignmentsArgs<TTable extends StatusTable> = {
  spec: TransitionSpec & { table: TTable };
  key: string;
  options: {
    from: readonly string[];
    to: string;
    set?: Readonly<Record<string, unknown>>;
    fence?: unknown;
    nextFence?: unknown;
  };
};

const transitionAssignments = <TTable extends StatusTable>({
  spec,
  key: identityKey,
  options,
}: TransitionAssignmentsArgs<TTable>) => {
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
      spec.scope?.includes(key) === true ||
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
      spec.scope?.includes(key) === true ||
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
  const runtimeOptions: {
    readonly fence?: unknown;
    readonly nextFence?: unknown;
  } = options;
  const expectedFence = runtimeOptions.fence;
  if (spec.fence !== undefined && expectedFence === undefined) {
    panic("The transition requires its declared fence");
  }
  if (spec.fence === undefined && expectedFence !== undefined) {
    panic("This transition table has no fence");
  }
  if (runtimeOptions.nextFence !== undefined) {
    if (fence === undefined) {
      panic("A fence advance requires the table's declared fence");
    }
    assignments.push(
      sql`${sql.identifier(fence.name)} = ${sql.param(runtimeOptions.nextFence, fence)}`,
    );
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

type TransitionScopeOptions = {
  table: StatusTable;
  keys: readonly string[];
  values: Readonly<Record<string, unknown>>;
};

const transitionScopePredicate = ({
  table,
  keys,
  values,
}: TransitionScopeOptions) => {
  const columns: Readonly<Record<string, AnyPgColumn>> = getColumns(table);
  if (keys.length !== Object.keys(values).length) {
    panic("A transition must bind every declared scope column");
  }
  const predicates = keys.map((key) => {
    const column = columns[key];
    if (column === undefined || !Object.hasOwn(values, key)) {
      panic("A transition scope binding is missing");
    }
    return sql`${column} = ${sql.param(values[key], column)}`;
  });
  return predicates.length === 0
    ? sql``
    : sql`AND ${sql.join(predicates, sql` AND `)}`;
};

type TransitionBatchArgs<
  TTx extends TransitionTransaction,
  TTable extends StatusTable,
  TKey extends keyof TTable["_"]["columns"] & string,
  TEdges extends Readonly<Record<string, readonly string[]>>,
  TOptions extends { terminal: readonly string[]; fence?: string },
  TScope extends readonly (keyof TTable["_"]["columns"] & string)[] | undefined,
> = {
  tx: TTx;
  spec: TransitionSpec & {
    table: TTable;
    key: TKey;
    idColumn: TTable["_"]["columns"][TKey];
    edges: TEdges;
    options: TOptions;
    scope: TScope;
  };
  ids: readonly GetColumnData<NoInfer<TTable>["_"]["columns"][NoInfer<TKey>]>[];
  options: Move<NoInfer<TEdges>> &
    Fence<NoInfer<TTable>, NoInfer<TOptions>> & {
      set?: Omit<
        PgUpdateSetSource<NoInfer<TTable>>,
        | NoInfer<TKey>
        | (TScope extends readonly string[] ? TScope[number] : never)
        | TransitionOwnedKeys<NoInfer<TOptions>>
      > &
        Partial<
          Record<
            | NoInfer<TKey>
            | (TScope extends readonly string[] ? TScope[number] : never)
            | TransitionOwnedKeys<NoInfer<TOptions>>,
            never
          >
        >;
    };
  recordTransitionAuditEvent: (
    tx: TTx,
    rows: readonly {
      id: GetColumnData<TTable["_"]["columns"][TKey]>;
      status: Status<TTable>;
    }[],
  ) => void | Promise<void>;
} & (TScope extends readonly (keyof TTable["_"]["columns"] & string)[]
  ? {
      scope: {
        [K in TScope[number]]: GetColumnData<TTable["_"]["columns"][K]>;
      };
    }
  : { scope?: never });

/** One conditional update per held batch; only changed rows reach its required audit. */
export const transitionBatch = async <
  TTx extends TransitionTransaction,
  TTable extends StatusTable,
  TKey extends keyof TTable["_"]["columns"] & string,
  const TEdges extends Readonly<Record<string, readonly string[]>>,
  TOptions extends { terminal: readonly string[]; fence?: string },
  const TScope extends
    | readonly (keyof TTable["_"]["columns"] & string)[]
    | undefined,
>({
  tx,
  spec,
  ids,
  options,
  recordTransitionAuditEvent,
  scope,
}: TransitionBatchArgs<TTx, TTable, TKey, TEdges, TOptions, TScope>) => {
  const { assignments, fence } = transitionAssignments({
    spec,
    key: spec.key,
    options,
  });
  if (ids.length === 0) {
    return [];
  }
  const scoped =
    spec.scope === undefined
      ? sql``
      : transitionScopePredicate({
          table: spec.table,
          keys: spec.scope,
          values: scope ?? {},
        });
  const rows = await tx.execute(sql`
    UPDATE ${spec.table}
    SET ${sql.join(assignments, sql`, `)}
    WHERE ${spec.idColumn} IN (${sql.join(
      ids.map((id) => sql`${sql.param(id, spec.idColumn)}`),
      sql`, `,
    )})
      ${scoped}
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
