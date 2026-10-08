import { panic, Result, TaggedError } from "better-result";
import {
  and,
  getColumnTable,
  getColumns,
  getTableName,
  is,
  SQL,
  sql,
} from "drizzle-orm";
import type { Subquery } from "drizzle-orm";
import { getTableConfig, PgColumn, PgTable } from "drizzle-orm/pg-core";
import type {
  LockConfig,
  LockStrength,
} from "drizzle-orm/pg-core/query-builders/select.types";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";

/** Registered blocking chains share one physical transaction order. */
export const AGGREGATE_LOCKS = {
  organization: { rank: 0, kind: "row" },
  orgFeatureAdmission: { rank: 10, kind: "advisory" },
  schedulerClaim: { rank: 20, kind: "row" },
  definitionCap: { rank: 30, kind: "advisory" },
  definition: { rank: 40, kind: "row" },
  scoutCensus: { rank: 60, kind: "row" },
  workspace: { rank: 100, kind: "row" },
  memberCleanup: { rank: 110, kind: "row" },
  // A chat interaction's fences: the thread, then the turn awaiting input,
  // then the receipt it produced.
  chatThread: { rank: 120, kind: "row" },
  chatTurn: { rank: 130, kind: "row" },
  chatSecret: { rank: 140, kind: "row" },
  run: { rank: 200, kind: "row" },
  currentStep: { rank: 300, kind: "row" },
  obligation: { rank: 400, kind: "row" },
  entity: { rank: 500, kind: "row" },
  processingClaim: { rank: 600, kind: "row" },
  contactCapacity: { rank: 700, kind: "advisory" },
  personalCatalog: { rank: 700, kind: "advisory" },
} as const;

export type AggregateName = keyof typeof AGGREGATE_LOCKS;

/** Derive rank proofs from the same registry used for acquisitions. */
export const AGGREGATE_CHAINS = {
  existing: [
    "organization",
    "workspace",
    "run",
    "currentStep",
    "obligation",
    "entity",
  ],
  automated: [
    "orgFeatureAdmission",
    "schedulerClaim",
    "definitionCap",
    "definition",
  ],
  flowEffect: [
    "orgFeatureAdmission",
    "workspace",
    "run",
    "currentStep",
    "obligation",
    "entity",
  ],
  deadlineClaim: ["orgFeatureAdmission", "processingClaim"],
  deadlineAcceptance: ["orgFeatureAdmission", "entity", "processingClaim"],
  deadlineEmission: [
    "orgFeatureAdmission",
    "scoutCensus",
    "entity",
    "processingClaim",
  ],
  scoutRun: ["orgFeatureAdmission", "scoutCensus"],
  chatSecret: ["chatThread", "chatTurn", "chatSecret"],
  memberPrefix: [
    "workspace",
    "memberCleanup",
    "run",
    "currentStep",
    "obligation",
    "entity",
  ],
  contactCapacity: ["contactCapacity"],
  personalCatalog: ["personalCatalog"],
} as const satisfies Record<string, readonly AggregateName[]>;

export const ROW_LOCK_MODES = [
  "key share",
  "share",
  "no key update",
  "update",
] as const satisfies readonly LockStrength[];
export type RowLockMode = (typeof ROW_LOCK_MODES)[number];
// Coverage follows PostgreSQL row-lock conflict sets; requested SQL still executes.
const MODE_COVERS = {
  "key share": ["key share"],
  share: ["key share", "share"],
  "no key update": ["key share", "share", "no key update"],
  update: ROW_LOCK_MODES,
} as const satisfies Record<RowLockMode, readonly RowLockMode[]>;
const modeCovers = (
  held: HeldLock["mode"],
  requested: HeldLock["mode"],
): boolean =>
  held === "advisory" || requested === "advisory"
    ? held === requested
    : MODE_COVERS[held].some((mode) => mode === requested);

type AggregateIdentities = {
  organization: SafeId<"organization">;
  orgFeatureAdmission: {
    organizationId: SafeId<"organization">;
    featureId: "flows" | "signals";
  };
  schedulerClaim: { id: string };
  definitionCap: { definitionId: SafeId<"flowDefinition"> };
  definition: {
    id: SafeId<"flowDefinition">;
    organizationId: SafeId<"organization">;
  };
  scoutCensus: {
    type: "run";
    id: SafeId<"scoutRun">;
    organizationId: SafeId<"organization">;
  };
  workspace: {
    id: SafeId<"workspace">;
    organizationId: SafeId<"organization">;
  };
  memberCleanup:
    | {
        type: "organization-member";
        id: string;
        organizationId: SafeId<"organization">;
      }
    | {
        type: "workspace-member";
        id: string;
        workspaceId: SafeId<"workspace">;
      };
  chatThread: {
    id: SafeId<"chatThread">;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  chatTurn: {
    threadId: SafeId<"chatThread">;
    toolCallId: string;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  chatSecret: {
    id: string;
    threadId: SafeId<"chatThread">;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  run: { id: SafeId<"flowRun">; workspaceId: SafeId<"workspace"> };
  currentStep: { id: SafeId<"flowRunStep">; workspaceId: SafeId<"workspace"> };
  obligation: { id: SafeId<"entity">; workspaceId: SafeId<"workspace"> };
  entity: { id: SafeId<"entity">; workspaceId: SafeId<"workspace"> };
  processingClaim: {
    id: SafeId<"documentProcessingRun">;
    workspaceId: SafeId<"workspace">;
  };
  contactCapacity: { organizationId: SafeId<"organization"> };
  personalCatalog: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
};

type ExecuteTransaction = { execute: (statement: SQL) => PromiseLike<unknown> };
type SavepointTransaction = Pick<Transaction, "execute" | "transaction">;
type AggregateIdentityOptions = {
  [Name in AggregateName]: { aggregate: Name; id: AggregateIdentities[Name] };
}[AggregateName];
type RowIdentityOptions = {
  [Name in AggregateName]: (typeof AGGREGATE_LOCKS)[Name]["kind"] extends "row"
    ? { aggregate: Name; id: AggregateIdentities[Name] }
    : never;
}[AggregateName];
type AdvisoryIdentityOptions = Exclude<
  AggregateIdentityOptions,
  RowIdentityOptions
>;
type WaitingOptions =
  | { wait?: "block"; tx: ExecuteTransaction }
  | { wait: "nowait"; tx: SavepointTransaction };
type AggregateLockOptions =
  | (RowIdentityOptions & { mode: RowLockMode } & WaitingOptions)
  | (AdvisoryIdentityOptions & {
      mode?: undefined;
      wait?: "block" | "nowait";
      tx: ExecuteTransaction;
    });

export class AggregateLockBusy extends TaggedError("AggregateLockBusy")<{
  message: string;
  aggregate: AggregateName;
}> {}
type AggregateLockResult =
  | { status: "locked" }
  | { status: "missing" }
  | { status: "busy"; error: AggregateLockBusy };
type HeldLock = {
  rank: number;
  key: string;
  orderKey: string;
  mode: RowLockMode | "advisory";
};
type OrderingReservation = Pick<HeldLock, "rank" | "key" | "orderKey">;
type LockHistory = {
  status: "idle" | "acquiring" | "closed";
  reservations: Map<string, OrderingReservation>;
  held: Map<string, HeldLock>;
  aliases: Map<string, string>;
  parent: LockHistory | undefined;
  children: Set<LockHistory>;
};

// Each level records its reservations and confirmed locks; ancestor history
// survives child rollback until the physical transaction ends.
const histories = new WeakMap<object, LockHistory>();
const lockHistory = (tx: object): LockHistory => {
  const existing = histories.get(tx);
  if (existing !== undefined) {
    return existing;
  }
  const history: LockHistory = {
    status: "idle",
    reservations: new Map(),
    held: new Map(),
    aliases: new Map(),
    parent: undefined,
    children: new Set(),
  };
  histories.set(tx, history);
  return history;
};
const assertIdleHistory = (history: LockHistory): void => {
  switch (history.status) {
    case "idle":
      return;
    case "acquiring":
      return panic(
        "Await each aggregate lock acquisition before starting another",
      );
    case "closed":
      return panic("Aggregate savepoint transaction is closed");
    default:
      history.status satisfies never;
      return panic("Unknown aggregate transaction state");
  }
};
const assertAggregateLevelAvailable = (history: LockHistory): void => {
  assertIdleHistory(history);
  if (history.children.size > 0) {
    panic(
      "Await the aggregate savepoint before reusing its parent transaction",
    );
  }
  let child = history;
  for (
    let parent = history.parent;
    parent !== undefined;
    parent = parent.parent
  ) {
    assertIdleHistory(parent);
    if (parent.children.size !== 1 || !parent.children.has(child)) {
      panic(
        "Await the aggregate savepoint before reusing its parent transaction",
      );
    }
    child = parent;
  }
};
const transactionHasAggregateLocks = (history: LockHistory): boolean => {
  let root = history;
  while (root.parent !== undefined) {
    root = root.parent;
  }
  const levels = [root];
  for (const level of levels) {
    if (level.reservations.size > 0 || level.status === "acquiring") {
      return true;
    }
    levels.push(...level.children);
  }
  return false;
};
const completeAcquisition = (history: LockHistory): void => {
  if (history.status !== "acquiring") {
    panic("Aggregate lock acquisition outlived its transaction level");
  }
  history.status = "idle";
};
const allHeldLocks = (history: LockHistory): HeldLock[] => {
  const held: HeldLock[] = [];
  for (
    let level: LockHistory | undefined = history;
    level !== undefined;
    level = level.parent
  ) {
    held.push(...level.held.values());
  }
  return held;
};
const allOrderingReservations = (
  history: LockHistory,
): OrderingReservation[] => {
  const reservations: OrderingReservation[] = [];
  for (
    let level: LockHistory | undefined = history;
    level !== undefined;
    level = level.parent
  ) {
    reservations.push(...level.reservations.values());
  }
  return reservations;
};
const assertLockOrder = (
  history: LockHistory,
  lock: HeldLock,
  wait: "block" | "nowait",
): void => {
  if (wait === "nowait") {
    return;
  }
  const held = allHeldLocks(history);
  if (
    held.some(
      (previous) =>
        previous.key === lock.key && modeCovers(previous.mode, lock.mode),
    )
  ) {
    return;
  }
  if (held.some((previous) => previous.key === lock.key)) {
    panic(
      "Take the strongest aggregate row mode first; use NOWAIT for upgrades",
    );
  }
  if (
    allOrderingReservations(history).some(
      (previous) =>
        lock.rank < previous.rank ||
        (lock.rank === previous.rank && lock.orderKey < previous.orderKey),
    )
  ) {
    panic("Aggregate lock rank inversion");
  }
};
const retainReservation = (
  history: LockHistory,
  reservation: OrderingReservation,
): void => {
  const previous = history.reservations.get(reservation.key);
  history.reservations.set(reservation.key, {
    key: reservation.key,
    rank: Math.max(previous?.rank ?? reservation.rank, reservation.rank),
    orderKey:
      previous !== undefined && previous.orderKey > reservation.orderKey
        ? previous.orderKey
        : reservation.orderKey,
  });
};
const retainLock = (history: LockHistory, lock: HeldLock): void => {
  retainReservation(history, lock);
  const previous = history.held.get(lock.key);
  history.held.set(
    lock.key,
    previous === undefined
      ? lock
      : {
          ...lock,
          rank: Math.max(previous.rank, lock.rank),
          orderKey:
            previous.orderKey > lock.orderKey
              ? previous.orderKey
              : lock.orderKey,
          mode: modeCovers(previous.mode, lock.mode)
            ? previous.mode
            : lock.mode,
        },
  );
};

/** A fresh physical transaction owns a fresh history, including failure/commit cleanup. */
export const withAggregateTransaction = async <Tx extends object, T>(
  database: {
    transaction: <Value>(run: (tx: Tx) => Promise<Value>) => Promise<Value>;
  },
  run: (tx: Tx) => Promise<T>,
): Promise<T> => {
  if (histories.has(database) || "rollback" in database) {
    panic("Use the aggregate savepoint owner for nested transactions");
  }
  return await database.transaction(async (tx) => {
    const history = lockHistory(tx);
    assertAggregateLevelAvailable(history);
    try {
      const value = await run(tx);
      assertAggregateLevelAvailable(history);
      return value;
    } finally {
      history.status = "closed";
    }
  });
};

/** Track the public savepoint callback without inspecting driver internals. */
export const withAggregateSavepoint = async <T>(
  tx: Pick<Transaction, "execute" | "transaction">,
  run: (savepoint: Transaction) => Promise<T>,
): Promise<T> => {
  const parent = lockHistory(tx);
  // Non-locking callers retain the driver's existing savepoint behavior.
  if (transactionHasAggregateLocks(parent)) {
    assertAggregateLevelAvailable(parent);
  }
  const history: LockHistory = {
    status: "idle",
    reservations: new Map(),
    held: new Map(),
    aliases: new Map(),
    parent,
    children: new Set(),
  };
  parent.children.add(history);
  try {
    const committed = await tx.transaction(async (savepoint) => {
      histories.set(savepoint, history);
      try {
        const value = await run(savepoint);
        if (transactionHasAggregateLocks(history)) {
          assertAggregateLevelAvailable(history);
        }
        return {
          value,
          reservations: history.reservations,
          held: history.held,
          aliases: history.aliases,
        };
      } finally {
        history.status = "closed";
      }
    });
    for (const reservation of committed.reservations.values()) {
      retainReservation(parent, reservation);
    }
    for (const lock of committed.held.values()) {
      retainLock(parent, lock);
    }
    for (const [logical, physical] of committed.aliases) {
      parent.aliases.set(logical, physical);
    }
    return committed.value;
  } finally {
    history.status = "closed";
    parent.children.delete(history);
  }
};

type RowResource = {
  table: string;
  columns: readonly string[];
  values: readonly (string | number)[];
  scopeColumns: readonly string[];
  scopeValues: readonly (string | number)[];
};
const rowResource = (options: RowIdentityOptions): RowResource => {
  switch (options.aggregate) {
    case "organization":
      return {
        table: "organization",
        columns: ["id"],
        values: [options.id],
        scopeColumns: [],
        scopeValues: [],
      };
    case "workspace":
      return {
        table: "workspaces",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["organization_id"],
        scopeValues: [options.id.organizationId],
      };
    case "run":
      return {
        table: "flow_runs",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["workspace_id"],
        scopeValues: [options.id.workspaceId],
      };
    case "currentStep":
      return {
        table: "flow_run_steps",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["workspace_id"],
        scopeValues: [options.id.workspaceId],
      };
    case "obligation":
      return {
        table: "work_obligations",
        columns: ["entity_id"],
        values: [options.id.id],
        scopeColumns: ["workspace_id"],
        scopeValues: [options.id.workspaceId],
      };
    case "entity":
      return {
        table: "entities",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["workspace_id"],
        scopeValues: [options.id.workspaceId],
      };
    case "schedulerClaim":
      return {
        table: "scheduler_jobs",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: [],
        scopeValues: [],
      };
    case "definition":
      return {
        table: "flow_definitions",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["organization_id"],
        scopeValues: [options.id.organizationId],
      };
    case "processingClaim":
      return {
        table: "document_processing_runs",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["workspace_id"],
        scopeValues: [options.id.workspaceId],
      };
    case "scoutCensus":
      return {
        table: "scout_runs",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["organization_id"],
        scopeValues: [options.id.organizationId],
      };
    case "chatThread":
      return {
        table: "chat_threads",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["organization_id", "user_id"],
        scopeValues: [options.id.organizationId, options.id.userId],
      };
    case "chatTurn":
      return {
        table: "chat_turns",
        columns: ["thread_id", "interaction_tool_call_id"],
        values: [options.id.threadId, options.id.toolCallId],
        scopeColumns: ["organization_id", "user_id"],
        scopeValues: [options.id.organizationId, options.id.userId],
      };
    case "chatSecret":
      return {
        table: "chat_secrets",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["thread_id", "organization_id", "user_id"],
        scopeValues: [
          options.id.threadId,
          options.id.organizationId,
          options.id.userId,
        ],
      };
    case "memberCleanup":
      switch (options.id.type) {
        case "organization-member":
          return {
            table: "member",
            columns: ["id"],
            values: [options.id.id],
            scopeColumns: ["organization_id"],
            scopeValues: [options.id.organizationId],
          };
        case "workspace-member":
          return {
            table: "workspace_members",
            columns: ["id"],
            values: [options.id.id],
            scopeColumns: ["workspace_id"],
            scopeValues: [options.id.workspaceId],
          };
        default:
          options.id satisfies never;
          return panic("Unknown member cleanup resource");
      }
    default:
      options satisfies never;
      return panic("Unknown row aggregate");
  }
};
const rowLock = (options: RowIdentityOptions, mode: RowLockMode): HeldLock => {
  const { table, values } = rowResource(options);
  const key = JSON.stringify(["row", table, ...values]);
  return {
    rank: AGGREGATE_LOCKS[options.aggregate].rank,
    key,
    orderKey: JSON.stringify([options.aggregate, table, ...values]),
    mode,
  };
};
const rowStatement = (
  options: RowIdentityOptions,
  mode: RowLockMode,
  wait: "block" | "nowait",
) => {
  const resource = rowResource(options);
  const columns = [...resource.columns, ...resource.scopeColumns];
  const values = [...resource.values, ...resource.scopeValues];
  const keys = columns.map(
    (column, index) =>
      sql`${sql.identifier(column)} = ${values.at(index) ?? panic("Missing aggregate row key")}`,
  );
  return sql`SELECT ${sql.join(
    resource.columns.map((column) => sql.identifier(column)),
    sql`, `,
  )} FROM ${sql.identifier("public")}.${sql.identifier(resource.table)} WHERE ${sql.join(keys, sql` AND `)} ${sql.raw(`FOR ${mode.toUpperCase()}`)} ${wait === "nowait" ? sql`NOWAIT` : sql``}`;
};
const advisoryResource = (options: AdvisoryIdentityOptions) => {
  switch (options.aggregate) {
    case "contactCapacity":
      return {
        first: sql`hashtext('contact_capacity')`,
        second: sql`hashtext(${options.id.organizationId})`,
        order: [options.aggregate, options.id.organizationId],
      };
    case "personalCatalog":
      return {
        first: sql`hashtext(${options.id.organizationId})`,
        second: sql`hashtext(${options.id.userId})`,
        order: [
          options.aggregate,
          options.id.organizationId,
          options.id.userId,
        ],
      };
    case "orgFeatureAdmission":
      return {
        first: sql`${0x0f_10_cc_aa}::integer`,
        second: sql`hashtext(${`${options.id.featureId}:${options.id.organizationId}`})`,
        order: [
          options.aggregate,
          options.id.organizationId,
          options.id.featureId,
        ],
      };
    case "definitionCap":
      return {
        first: sql`${0x0f_10_cc_a9}::integer`,
        second: sql`hashtext(${options.id.definitionId})`,
        order: [options.aggregate, options.id.definitionId],
      };
    default:
      options satisfies never;
      return panic("Unknown advisory aggregate");
  }
};
const busy = (aggregate: AggregateName): AggregateLockResult => ({
  status: "busy",
  error: new AggregateLockBusy({
    aggregate,
    message: "The requested aggregate lock is busy",
  }),
});
const knownAdvisoryKey = (history: LockHistory, logical: string): string => {
  for (
    let level: LockHistory | undefined = history;
    level !== undefined;
    level = level.parent
  ) {
    const key = level.aliases.get(logical);
    if (key !== undefined) {
      return key;
    }
  }
  return logical;
};
const physicalAdvisoryKey = (row: unknown): string => {
  if (
    !isRecord(row) ||
    typeof row["key1"] !== "number" ||
    typeof row["key2"] !== "number"
  ) {
    return panic("Missing physical advisory lock identity");
  }
  return JSON.stringify(["advisory", row["key1"], row["key2"]]);
};

/** Blocking acquisitions ascend; explicit nonblocking requests retain the high-water on success. */
export const withAggregateLock = async (
  options: AggregateLockOptions,
): Promise<AggregateLockResult> => {
  const { tx, aggregate } = options;
  const wait = options.wait ?? "block";
  const history = lockHistory(tx);
  assertAggregateLevelAvailable(history);
  if (options.mode === undefined) {
    const resource = advisoryResource(options);
    const logicalKey = JSON.stringify(resource.order);
    const lock = {
      rank: AGGREGATE_LOCKS[aggregate].rank,
      key: knownAdvisoryKey(history, logicalKey),
      orderKey: logicalKey,
      mode: "advisory",
    } as const;
    assertLockOrder(history, lock, wait);
    history.status = "acquiring";
    const rows = executedRows(
      await tx.execute(
        sql`SELECT ${resource.first} AS key1, ${resource.second} AS key2, ${wait === "nowait" ? sql`pg_try_advisory_xact_lock(${resource.first}, ${resource.second})` : sql`pg_advisory_xact_lock(${resource.first}, ${resource.second})`} AS acquired`,
      ),
    );
    const row = rows.at(0);
    const key = physicalAdvisoryKey(row);
    if (
      wait === "nowait" &&
      (!isRecord(row) || typeof row["acquired"] !== "boolean")
    ) {
      panic("Missing advisory acquisition outcome");
    }
    const acquired =
      wait === "block" || (isRecord(row) && row["acquired"] === true);
    if (acquired) {
      history.aliases.set(logicalKey, key);
      retainLock(history, { ...lock, key });
    }
    completeAcquisition(history);
    return acquired ? { status: "locked" } : busy(aggregate);
  }
  const mode = options.mode;
  const lock = rowLock(options, mode);
  assertLockOrder(history, lock, wait);
  if (options.wait === "nowait") {
    const result = await Result.tryPromise(
      async () =>
        await withAggregateSavepoint(options.tx, async (child) => {
          const childHistory = lockHistory(child);
          assertAggregateLevelAvailable(childHistory);
          childHistory.status = "acquiring";
          const rows = executedRows(
            await child.execute(rowStatement(options, mode, "nowait")),
          );
          if (rows.length > 0) {
            retainLock(childHistory, lock);
          }
          completeAcquisition(childHistory);
          return rows.length === 0
            ? ({ status: "missing" } as const)
            : ({ status: "locked" } as const);
        }),
    );
    if (result.isOk()) {
      return result.value;
    }
    if (getPgErrorCode(result.error) === PG_ERROR.LOCK_NOT_AVAILABLE) {
      return busy(aggregate);
    }
    return abortTransaction(result.error.cause);
  }
  history.status = "acquiring";
  const rows = executedRows(
    await tx.execute(rowStatement(options, mode, "block")),
  );
  if (rows.length > 0) {
    retainLock(history, lock);
  }
  completeAcquisition(history);
  return rows.length > 0 ? { status: "locked" } : { status: "missing" };
};

type AggregateLockableQuery<Row> = {
  for: (mode: RowLockMode, config?: LockConfig) => PromiseLike<Row[]>;
  toSQL: () => { sql: string };
  as: (alias: string) => Subquery;
};
type AggregateRowQueryOptions<Row> = RowIdentityOptions & {
  mode: RowLockMode;
  select: (tx: Transaction) => {
    where: (predicate: SQL) => AggregateLockableQuery<Row>;
    toSQL: () => { sql: string };
    as: (alias: string) => Subquery;
  };
  where?: SQL;
  lockConfig?: Omit<LockConfig, "noWait" | "skipLocked">;
} & ({ tx: Transaction; wait?: "block" } | { tx: Transaction; wait: "nowait" });
type AggregateRowsResult<Row> =
  | { status: "locked" | "missing"; rows: Row[] }
  | { status: "busy"; error: AggregateLockBusy };

type SelectToken = {
  kind: "word" | "identifier" | "symbol";
  value: string;
  depth: number;
};
const dollarDelimiter = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/uy;

const quotedToken = (source: string, start: number) => {
  const quote = source[start];
  const escaped =
    quote === "'" &&
    /(?:^|[^A-Za-z0-9_])(?:E|U&)$/iu.test(
      source.slice(Math.max(0, start - 3), start),
    );
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped && character === "\\") {
      index += 1;
      continue;
    }
    if (character !== quote) {
      if (quote === '"') {
        value += character;
      }
      continue;
    }
    if (source[index + 1] === quote) {
      if (quote === '"') {
        value += quote;
      }
      index += 1;
      continue;
    }
    return { end: index + 1, value };
  }
  return panic("Unterminated aggregate query quote");
};

const blockCommentEnd = (source: string, start: number) => {
  let depth = 1;
  for (let index = start + 2; index < source.length; index += 1) {
    if (source.startsWith("/*", index)) {
      depth += 1;
      index += 1;
    } else if (source.startsWith("*/", index)) {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return panic("Unterminated aggregate query comment");
};

/** Nested syntax is retained only to reject untracked row-lock clauses. */
const outerSelectTokens = (source: string): SelectToken[] => {
  const tokens: SelectToken[] = [];
  let depth = 0;
  let index = 0;
  while (index < source.length) {
    const character =
      source[index] ?? panic("Missing aggregate query character");
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("--", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = blockCommentEnd(source, index);
      continue;
    }
    if (character === "'" || character === '"') {
      const quoted = quotedToken(source, index);
      if (character === '"') {
        tokens.push({ kind: "identifier", value: quoted.value, depth });
      }
      index = quoted.end;
      continue;
    }
    if (character === "$") {
      dollarDelimiter.lastIndex = index;
      const delimiter = dollarDelimiter.exec(source)?.at(0);
      if (delimiter !== undefined) {
        const end = source.indexOf(delimiter, index + delimiter.length);
        if (end === -1) {
          return panic("Unterminated aggregate query dollar quote");
        }
        index = end + delimiter.length;
        continue;
      }
    }
    if (character === "(") {
      if (depth === 0) {
        tokens.push({ kind: "symbol", value: character, depth });
      }
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth < 0) {
        return panic("Unbalanced aggregate query parentheses");
      }
      if (depth === 0) {
        tokens.push({ kind: "symbol", value: character, depth });
      }
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = index;
      do {
        index += 1;
      } while (
        index < source.length &&
        /[A-Za-z0-9_$]/u.test(source[index] ?? "")
      );
      tokens.push({
        kind: "word",
        value: source.slice(start, index).toLowerCase(),
        depth,
      });
      continue;
    }
    tokens.push({ kind: "symbol", value: character, depth });
    index += 1;
  }
  if (depth !== 0) {
    return panic("Unbalanced aggregate query parentheses");
  }
  return tokens;
};

const aggregateSelectTarget = (source: string) => {
  const allTokens = outerSelectTokens(source);
  for (const [index, token] of allTokens.entries()) {
    if (token.kind !== "word" || token.value !== "for") {
      continue;
    }
    if (token.depth === 0) {
      panic("Aggregate query must not include a locking clause");
    }
    const strength = allTokens.at(index + 1);
    if (
      strength?.kind === "word" &&
      strength.depth === token.depth &&
      ["update", "share", "key", "no"].includes(strength.value)
    ) {
      panic("Nested aggregate row locking clauses are not tracked");
    }
  }
  const tokens = allTokens.filter((token) => token.depth === 0);
  if (tokens.some((token) => token.kind === "word" && token.value === "of")) {
    panic("Aggregate query must not include a locking clause");
  }
  if (
    tokens.some((token) => token.kind === "word" && token.value === "offset")
  ) {
    panic("Aggregate query must not include an offset");
  }
  const first = tokens.at(0);
  const fromIndexes = tokens.flatMap((token, index) =>
    token.kind === "word" && token.value === "from" ? [index] : [],
  );
  const fromIndex = fromIndexes.at(0);
  if (
    first?.kind !== "word" ||
    first.value !== "select" ||
    fromIndexes.length !== 1 ||
    fromIndex === undefined ||
    tokens.some((token) => token.kind === "symbol" && token.value === ";") ||
    tokens.some(
      (token) =>
        token.kind === "word" &&
        ["union", "intersect", "except"].includes(token.value),
    )
  ) {
    return panic("Unsupported aggregate SELECT target");
  }
  const table = tokens.at(fromIndex + 1);
  const following = tokens.at(fromIndex + 2);
  const supportedClause =
    following === undefined ||
    (following.kind === "word" &&
      [
        "where",
        "join",
        "inner",
        "left",
        "right",
        "full",
        "cross",
        "natural",
        "order",
        "group",
        "limit",
        "offset",
        "for",
        "fetch",
        "having",
        "window",
      ].includes(following.value));
  if (table === undefined || table.kind === "symbol" || !supportedClause) {
    return panic("Unsupported aggregate SELECT target");
  }
  return {
    table: table.value,
    joined: tokens.some(
      (token) => token.kind === "word" && token.value === "join",
    ),
    filtered: tokens.some(
      (token) => token.kind === "word" && token.value === "where",
    ),
  };
};

type ProjectedColumn = { path: readonly string[]; column: PgColumn };
type CollectProjectedColumnsOptions = {
  selection: Record<string, unknown>;
  path: readonly string[];
  output: ProjectedColumn[];
  ancestors: Set<object>;
};

const collectProjectedColumns = ({
  selection,
  path,
  output,
  ancestors,
}: CollectProjectedColumnsOptions): void => {
  if (ancestors.has(selection)) {
    panic("Cyclic aggregate query projection");
  }
  ancestors.add(selection);
  // Descriptor values avoid the public selection proxy's throw for unrelated raw SQL extras.
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(selection),
  )) {
    const field: unknown = descriptor.value;
    const fieldPath = path.concat(key);
    if (is(field, PgColumn)) {
      output.push({ path: fieldPath, column: field });
      continue;
    }
    if (is(field, PgTable)) {
      collectProjectedColumns({
        selection: getColumns(field),
        path: fieldPath,
        output,
        ancestors,
      });
      continue;
    }
    if (is(field, SQL) || is(field, SQL.Aliased)) {
      continue;
    }
    if (isRecord(field)) {
      collectProjectedColumns({
        selection: field,
        path: fieldPath,
        output,
        ancestors,
      });
    }
  }
  ancestors.delete(selection);
};

type RegisteredProjection = {
  path: readonly string[];
  expected: string | number;
  kind: "physical" | "tenant";
  position: number;
};
const registeredProjection = (
  selection: Record<string, unknown>,
  resource: RowResource,
): RegisteredProjection[] => {
  const columns: ProjectedColumn[] = [];
  collectProjectedColumns({
    selection,
    path: [],
    output: columns,
    ancestors: new Set(),
  });
  const names = resource.columns.concat(resource.scopeColumns);
  const values = resource.values.concat(resource.scopeValues);
  return names.flatMap((name, index) => {
    const matching = columns.filter(({ column }) => {
      if (column.name !== name) {
        return false;
      }
      const table = getColumnTable(column);
      if (!is(table, PgTable)) {
        return false;
      }
      const config = getTableConfig(table);
      return (
        config.name === resource.table &&
        (config.schema === undefined || config.schema === "public")
      );
    });
    if (matching.length === 0) {
      panic(
        "Aggregate query must project its registered physical and tenant columns",
      );
    }
    const expected =
      values.at(index) ??
      panic("Missing registered aggregate projection value");
    const kind = index < resource.columns.length ? "physical" : "tenant";
    return matching.map(
      ({ path }) =>
        ({
          path,
          expected,
          kind,
          position: index,
        }) satisfies RegisteredProjection,
    );
  });
};

type ProjectedValue = RegisteredProjection & { value: unknown };
const projectedRowValues = (
  row: unknown,
  projection: readonly RegisteredProjection[],
): ProjectedValue[] =>
  projection.map((column) => {
    let value: unknown = row;
    for (const key of column.path) {
      if (!isRecord(value)) {
        panic("Aggregate query returned an invalid registered projection");
      }
      value = value[key];
    }
    return { ...column, value };
  });

const projectedPhysicalIdentity = (
  row: readonly ProjectedValue[],
): (string | number)[] => {
  const physicalValues: (string | number)[] = [];
  for (const { value, kind, position } of row) {
    if (kind !== "physical") {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      panic("Aggregate query returned an invalid physical key");
    }
    physicalValues[position] = value;
  }
  return physicalValues;
};

const validateProjectedRows = (rows: readonly ProjectedValue[][]): void => {
  if (rows.length > 1) {
    panic("Aggregate query returned more than one physical row");
  }
  for (const row of rows) {
    for (const { value, expected } of row) {
      if (value !== expected) {
        panic(
          "Aggregate query returned an undeclared physical or tenant resource",
        );
      }
    }
  }
};

/** Apply the registered identity and tenant predicate before locking; extra predicates can only narrow it. */
export const withAggregateRowQuery = async <Row>(
  options: AggregateRowQueryOptions<Row>,
): Promise<AggregateRowsResult<Row>> => {
  const history = lockHistory(options.tx);
  assertAggregateLevelAvailable(history);
  const wait = options.wait ?? "block";
  const requested = rowLock(options, options.mode);
  assertLockOrder(history, requested, wait);
  const acquire = async (
    tx: Transaction,
  ): Promise<AggregateRowsResult<Row>> => {
    const queryHistory = lockHistory(tx);
    assertAggregateLevelAvailable(queryHistory);
    const query = options.select(tx);
    const resource = rowResource(options);
    const table = resource.table;
    const target = aggregateSelectTarget(query.toSQL().sql);
    if (target.table !== table) {
      panic("Aggregate query target does not match its registered resource");
    }
    if (target.filtered) {
      panic("Pass additional aggregate predicates through the where option");
    }
    const of = options.lockConfig?.of;
    if (of !== undefined) {
      const targets = Array.isArray(of) ? of : [of];
      if (
        targets.length !== 1 ||
        targets.some((lockTarget) => getTableName(lockTarget) !== table)
      ) {
        panic(
          "Aggregate query lock target does not match its registered resource",
        );
      }
    } else if (target.joined) {
      panic("Joined aggregate query requires an explicit registered OF target");
    }
    const projection = registeredProjection(
      getColumns(query.as("aggregate_projection")),
      resource,
    );
    const columns = [...resource.columns, ...resource.scopeColumns];
    const values = [...resource.values, ...resource.scopeValues];
    const predicate =
      and(
        ...columns.map(
          (column, index) =>
            sql`${sql.identifier(table)}.${sql.identifier(column)} = ${values.at(index) ?? panic("Missing aggregate row key")}`,
        ),
        options.where,
      ) ?? panic("Missing registered aggregate predicate");
    const scopedQuery = query.where(predicate);
    aggregateSelectTarget(scopedQuery.toSQL().sql);
    assertAggregateLevelAvailable(queryHistory);
    queryHistory.status = "acquiring";
    const rows = await scopedQuery.for(
      options.mode,
      wait === "nowait"
        ? { ...options.lockConfig, noWait: true }
        : options.lockConfig,
    );
    // PostgreSQL may lock a snapshot-matching row and omit it after rechecking
    // an updated predicate. Reserve its order, but only returned rows confirm
    // held coverage for later acquisitions of the same identity.
    // https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
    retainReservation(queryHistory, requested);
    const projected = rows.map((row) => projectedRowValues(row, projection));
    // The query already holds these locks, even when its returned rows fail validation.
    for (const row of projected) {
      const physicalValues = projectedPhysicalIdentity(row);
      retainLock(queryHistory, {
        ...requested,
        key: JSON.stringify(["row", table, ...physicalValues]),
        orderKey: JSON.stringify([options.aggregate, table, ...physicalValues]),
      });
    }
    completeAcquisition(queryHistory);
    validateProjectedRows(projected);
    return { status: rows.length === 0 ? "missing" : "locked", rows };
  };
  if (wait === "nowait") {
    const result = await Result.tryPromise(
      async () => await withAggregateSavepoint(options.tx, acquire),
    );
    if (result.isOk()) {
      return result.value;
    }
    if (getPgErrorCode(result.error) === PG_ERROR.LOCK_NOT_AVAILABLE) {
      return {
        status: "busy",
        error: new AggregateLockBusy({
          aggregate: options.aggregate,
          message: "The requested aggregate lock is busy",
        }),
      };
    }
    return abortTransaction(result.error.cause);
  }
  return await acquire(options.tx);
};
