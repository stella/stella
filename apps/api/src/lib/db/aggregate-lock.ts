import { panic, Result, TaggedError } from "better-result";
import {
  and,
  asc,
  eq,
  getColumns,
  getColumnTable,
  getTableName,
  inArray,
  is,
  isNotNull,
  isNull,
  lte,
  or,
  SQL,
  sql,
} from "drizzle-orm";
import type { Subquery } from "drizzle-orm";
import { getTableConfig, PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  LockConfig,
  LockStrength,
} from "drizzle-orm/pg-core/query-builders/select.types";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { declareFingerprintFields } from "@stll/errors";

import { member, organization } from "@/api/db/auth-schema";
import type {
  OnlineMigrationConnection,
  OnlineMigrationParam,
} from "@/api/db/online-migration-connection";
import type { Transaction } from "@/api/db/root";
import type { InvoiceStatus, SearchProjectionKind } from "@/api/db/schema";
import {
  billingArrangements,
  billingCodes,
  caseLawReplayBatches,
  entities,
  entityVersions,
  fields,
  invoiceLines,
  invoices,
  organizationSettings,
  pdfSigningSessions,
  requestIdempotencyReceipts,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { withSharedTransactionTimeoutRestoration } from "@/api/db/shared-pool-timeouts";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readBounded } from "@/api/lib/db/read-bounded";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { LIMITS } from "@/api/lib/limits";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import {
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/** Registered blocking chains share one physical transaction order. */
export const AGGREGATE_LOCKS = {
  requestReceipt: { rank: -10, kind: "row" },
  account: { rank: -20, kind: "row" },
  accountExport: { rank: -10, kind: "row" },
  accountDeletionRequest: { rank: -10, kind: "row" },
  organizationObjectIntent: { rank: -1, kind: "advisory" },
  organization: { rank: 0, kind: "row" },
  professionalUseAcceptance: { rank: 5, kind: "advisory" },
  orgFeatureAdmission: { rank: 10, kind: "advisory" },
  schedulerClaim: { rank: 20, kind: "row" },
  definitionCap: { rank: 30, kind: "advisory" },
  definition: { rank: 40, kind: "row" },
  // Global fence for linking republished rulings and discovering their aliases.
  // Take it before any case-law decision row lock: link pages use exclusive
  // mode, while erasures use shared mode so independent erasures can proceed.
  caseLawRepublication: { rank: 45, kind: "advisory" },
  // Public-corpus work fence is taken before its legacy projection/expression locks.
  legislationAmendmentWork: { rank: 50, kind: "advisory" },
  scoutCensus: { rank: 60, kind: "row" },
  desktopMembership: { rank: 70, kind: "row" },
  desktopCredential: { rank: 80, kind: "row" },
  desktopBatch: { rank: 90, kind: "advisory" },
  chatOwnerStoredContentEgress: { rank: 95, kind: "advisory" },
  workspace: { rank: 100, kind: "row" },
  memberCleanup: { rank: 110, kind: "row" },
  chatStoredContentEgress: { rank: 115, kind: "advisory" },
  // A chat interaction's fences: the thread, then the turn awaiting input,
  // then the receipt it produced.
  chatThread: { rank: 120, kind: "row" },
  readerAnswer: { rank: 120, kind: "row" },
  readerAnnotation: { rank: 120, kind: "advisory" },
  readerAnswerMessage: { rank: 130, kind: "row" },
  chatTurn: { rank: 130, kind: "row" },
  chatSecret: { rank: 140, kind: "row" },
  chatToolGrants: { rank: 150, kind: "advisory" },
  run: { rank: 200, kind: "row" },
  currentStep: { rank: 300, kind: "row" },
  obligation: { rank: 400, kind: "row" },
  folioCollabRoom: { rank: 450, kind: "row" },
  entity: { rank: 500, kind: "row" },
  entityVersion: { rank: 510, kind: "row" },
  field: { rank: 520, kind: "row" },
  memory: { rank: 530, kind: "row" },
  searchProjectionRepair: { rank: 540, kind: "row" },
  signal: { rank: 600, kind: "row" },
  automatedFlowRunCap: { rank: 700, kind: "advisory" },
  processingClaim: { rank: 600, kind: "row" },
  contactCapacity: { rank: 700, kind: "advisory" },
  fileComparisonCapacity: { rank: 700, kind: "advisory" },
  billingCodeCapacity: { rank: 700, kind: "advisory" },
  expenseCapacity: { rank: 700, kind: "advisory" },
  rateTableWorkspace: { rank: 700, kind: "advisory" },
  mcpOAuthState: { rank: 700, kind: "advisory" },
  personalCatalog: { rank: 700, kind: "advisory" },
  sampleCase: { rank: 700, kind: "advisory" },
  searchHistory: { rank: 710, kind: "row" },
  chatMessage: { rank: 810, kind: "row" },
  signingSession: { rank: 900, kind: "row" },
} as const;

export type AggregateName = keyof typeof AGGREGATE_LOCKS;

type OrganizationFencedRepairBatchOptions = {
  connection: Pick<OnlineMigrationConnection, "query">;
  query: string;
  params: readonly OnlineMigrationParam[];
};

/**
 * Online repairs own native transactions instead of Drizzle transactions.
 * Their batch query joins organization as tenant; key-share fencing preserves
 * that parent until dependent metadata commits without locking source rows.
 */
export const queryOrganizationFencedRepairBatch = async ({
  connection,
  query,
  params,
}: OrganizationFencedRepairBatchOptions) =>
  await connection.query(`${query} FOR KEY SHARE OF tenant`, params);

type InvoiceRepairBatchOptions = {
  connection: Pick<OnlineMigrationConnection, "query">;
  predicate: string;
  limit: number;
};

/** Online invoice repairs hold their candidates through the batch transaction. */
export const lockInvoiceRepairBatch = async ({
  connection,
  predicate,
  limit,
}: InvoiceRepairBatchOptions) =>
  await connection.query(
    `SELECT i.id FROM public.invoices i WHERE ${predicate} ORDER BY i.id LIMIT $1 FOR UPDATE OF i`,
    [limit],
  );

/** Derive rank proofs from the same registry used for acquisitions. */
export const AGGREGATE_CHAINS = {
  requestReceipt: ["requestReceipt", "organization", "workspace", "entity"],
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
  legislationAmendments: ["legislationAmendmentWork"],
  caseLawRepublication: ["caseLawRepublication"],
  chatSecret: ["chatThread", "chatTurn", "chatSecret"],
  chatToolGrants: ["chatThread", "chatToolGrants"],
  chatStoredContent: [
    "chatOwnerStoredContentEgress",
    "chatStoredContentEgress",
    "chatThread",
    "chatTurn",
  ],
  memberPrefix: [
    "workspace",
    "memberCleanup",
    "run",
    "currentStep",
    "obligation",
    "entity",
  ],
  accountExport: ["account", "accountExport"],
  accountDeletionRequest: ["account", "accountDeletionRequest"],
  organizationObjectIntentLifecycle: [
    "organizationObjectIntent",
    "organization",
  ],
  organizationObjectIntentWriter: ["organizationObjectIntent", "workspace"],
  professionalUseAcceptance: ["professionalUseAcceptance"],
  desktopRenewal: ["desktopMembership", "desktopCredential"],
  desktopBatch: ["desktopBatch", "workspace"],
  documentSource: [
    "workspace",
    "entity",
    "entityVersion",
    "field",
    "processingClaim",
  ],
  folioPublication: [
    "workspace",
    "folioCollabRoom",
    "entity",
    "entityVersion",
    "field",
    "processingClaim",
  ],
  signal: ["signal"],
  automatedFlowRunCap: ["automatedFlowRunCap"],
  contactCapacity: ["contactCapacity"],
  fileComparisonCapacity: ["fileComparisonCapacity"],
  billingCodeCapacity: ["billingCodeCapacity"],
  expenseCapacity: ["expenseCapacity"],
  rateTableWorkspace: ["rateTableWorkspace"],
  mcpOAuthState: ["mcpOAuthState"],
  personalCatalog: ["personalCatalog"],
  sampleCase: ["workspace", "sampleCase"],
  searchHistory: ["desktopMembership", "searchHistory"],
  memory: ["memory"],
  searchProjectionRepair: ["searchProjectionRepair"],
  chatRevision: ["chatThread", "chatMessage"],
  readerAnswer: ["readerAnswer", "readerAnswerMessage"],
  readerAnnotation: ["readerAnnotation"],
  signingSession: ["workspace", "signingSession"],
} as const satisfies Record<string, readonly AggregateName[]>;

export const ROW_LOCK_MODES = [
  "key share",
  "share",
  "no key update",
  "update",
] as const satisfies readonly LockStrength[];
export type RowLockMode = (typeof ROW_LOCK_MODES)[number];
export const ADVISORY_LOCK_MODES = ["shared", "exclusive"] as const;
type AdvisoryLockMode = (typeof ADVISORY_LOCK_MODES)[number];
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
): boolean => {
  if (held === "advisory shared") {
    return requested === "advisory shared";
  }
  if (held === "advisory exclusive") {
    return (
      requested === "advisory shared" || requested === "advisory exclusive"
    );
  }
  if (requested === "advisory shared" || requested === "advisory exclusive") {
    return false;
  }
  return MODE_COVERS[held].some((mode) => mode === requested);
};

type AggregateIdentities = {
  requestReceipt: {
    id: SafeId<"requestIdempotencyReceipt">;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  legislationAmendmentWork: {
    sourceId: SafeId<"legislationSource">;
    eli: string;
    language: string;
  };
  account: SafeId<"user">;
  accountExport: { id: string; userId: SafeId<"user"> };
  accountDeletionRequest: SafeId<"accountDeletionRequest">;
  sampleCase: { workspaceId: SafeId<"workspace"> };
  organizationObjectIntent: SafeId<"organization">;
  organization: SafeId<"organization">;
  professionalUseAcceptance: { userId: SafeId<"user"> };
  desktopMembership: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  desktopCredential: { id: string; userId: SafeId<"user"> };
  desktopBatch: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
    idempotencyKey: string;
  };
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
  caseLawRepublication: "global";
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
  chatOwnerStoredContentEgress: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  chatStoredContentEgress: SafeId<"chatThread">;
  chatThread: {
    id: SafeId<"chatThread">;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  readerAnswer: {
    id: SafeId<"legalReaderAnswer">;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  readerAnnotation: {
    id: SafeId<"legalReaderAnnotation">;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  readerAnswerMessage: {
    id: SafeId<"legalReaderAnswerMessage">;
    answerId: SafeId<"legalReaderAnswer">;
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
  folioCollabRoom: {
    id: SafeId<"folioCollabRoom">;
    workspaceId: SafeId<"workspace">;
  };
  entity: { id: SafeId<"entity">; workspaceId: SafeId<"workspace"> };
  entityVersion: {
    id: SafeId<"entityVersion">;
    workspaceId: SafeId<"workspace">;
  };
  field: { id: SafeId<"field">; workspaceId: SafeId<"workspace"> };
  memory: {
    id: SafeId<"aiMemory">;
    organizationId: SafeId<"organization">;
  };
  searchProjectionRepair: {
    kind: SearchProjectionKind;
    revision: string;
    sourceId: string;
  };
  signal: { id: SafeId<"signal">; organizationId: SafeId<"organization"> };
  automatedFlowRunCap: SafeId<"flowDefinition">;
  processingClaim: {
    id: SafeId<"documentProcessingRun">;
    workspaceId: SafeId<"workspace">;
  };
  contactCapacity: { organizationId: SafeId<"organization"> };
  chatToolGrants: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  fileComparisonCapacity: { organizationId: SafeId<"organization"> };
  billingCodeCapacity: { workspaceId: SafeId<"workspace"> };
  expenseCapacity: { workspaceId: SafeId<"workspace"> };
  rateTableWorkspace: { workspaceId: SafeId<"workspace"> };
  mcpOAuthState: {
    connectorId: SafeId<"mcpConnector">;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  personalCatalog: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  searchHistory: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  chatMessage: { id: SafeId<"chatMessage">; threadId: SafeId<"chatThread"> };
  signingSession: {
    id: SafeId<"pdfSigningSession">;
    workspaceId: SafeId<"workspace">;
    organizationId: SafeId<"organization">;
  };
};

// Advisory first-key namespaces are a deployed contract: old and new workers
// must take the same lock for the same work during a rolling deployment.
// aggregate-lock-namespaces.json beside this file records each one, and
// scripts/check-aggregate-locks.ts holds it to the base revision.
const CHAT_STORED_CONTENT_EGRESS_LOCK_NAMESPACE = 0x0f_10_cc_b3;
const CHAT_OWNER_STORED_CONTENT_EGRESS_LOCK_NAMESPACE = 0x0f_10_cc_b4;
const ORGANIZATION_OBJECT_INTENT_LOCK_NAMESPACE = 0x0f_10_cc_b0;
const READER_ANNOTATION_LOCK_NAMESPACE = 0x0f_10_cc_af;

const chatOwnerStoredContentEgressKey = ({
  organizationId,
  userId,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) => `${organizationId}\u001f${userId}`;

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
      mode?: AdvisoryLockMode;
      wait?: "block" | "nowait";
      tx: ExecuteTransaction;
    });

type RowLockOptions = Extract<AggregateLockOptions, { mode: RowLockMode }>;
const isRowLockOptions = (
  options: AggregateLockOptions,
): options is RowLockOptions =>
  AGGREGATE_LOCKS[options.aggregate].kind === "row";

export class AggregateLockBusy extends TaggedError("AggregateLockBusy")<{
  message: string;
  aggregate: AggregateName;
}> {}
export class AggregateLockUpgradeRefused extends TaggedError(
  "AggregateLockUpgradeRefused",
)<{
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
  mode: RowLockMode | `advisory ${AdvisoryLockMode}`;
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
        (lock.rank === previous.rank &&
          compareCodeUnit(lock.orderKey, previous.orderKey) < 0),
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
      previous !== undefined &&
      compareCodeUnit(previous.orderKey, reservation.orderKey) > 0
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
            compareCodeUnit(previous.orderKey, lock.orderKey) > 0
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

type SkipLockedBatchOptions<Tx extends object, Row, T> = {
  database: {
    transaction: <Value>(run: (tx: Tx) => Promise<Value>) => Promise<Value>;
  };
  limit: number;
  prepare?: (tx: Tx) => Promise<void>;
  select: (tx: Tx) => {
    toSQL: () => { sql: string };
    limit: (limit: number) => {
      for: (mode: RowLockMode, config: LockConfig) => PromiseLike<Row[]>;
    };
  };
  run: (tx: Tx, rows: Row[]) => T | Promise<T>;
};

/** Nonblocking batches own a fresh transaction and forbid later aggregate acquisitions. */
export const withSkipLockedBatch = async <Tx extends object, Row, T>({
  database,
  limit,
  prepare,
  select,
  run,
}: SkipLockedBatchOptions<Tx, Row, T>): Promise<T> => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    panic("Skip-locked batches require a bounded positive limit");
  }
  return await withAggregateTransaction(database, async (tx) => {
    const history = lockHistory(tx);
    await prepare?.(tx);
    const query = select(tx);
    const target = aggregateSelectTarget(query.toSQL().sql);
    if (target.joined || !target.filtered) {
      panic("Skip-locked batches require a filtered single-table query");
    }
    // These locks never wait, but holding them while acquiring a blocking
    // aggregate would reintroduce an unordered chain. Keep that path closed.
    history.status = "acquiring";
    const rows = await query.limit(limit).for("update", { skipLocked: true });
    const value = await run(tx, rows);
    completeAcquisition(history);
    return value;
  });
};

const executorSavepoints = new WeakSet<object>();

type ExecutorSavepointDecision<T> = {
  type: "commit" | "rollback";
  value: T;
};

export class ExecutorSavepointError extends TaggedError(
  "ExecutorSavepointError",
)<{
  message: string;
  cause: unknown;
  phase: "setup" | "callback" | "cleanup";
}> {
  static {
    declareFingerprintFields(this, ["phase"]);
  }
}

/**
 * A savepoint for execute-only callbacks. The callback must not acquire typed
 * aggregate handles: those require withAggregateSavepoint and its lock history.
 * One executor cannot own overlapping or nested scopes. Admission covers timeout
 * capture through restoration, including savepoint cleanup.
 */
export const withExecutorSavepoint = async <T>(
  tx: { execute: (statement: SQL) => Promise<unknown> },
  run: (previous: {
    statementTimeoutMs: number;
    lockTimeoutMs: number;
  }) => Promise<ExecutorSavepointDecision<T>>,
): Promise<Result<T, ExecutorSavepointError>> => {
  if (executorSavepoints.has(tx)) {
    return panic("Await the executor savepoint before reusing its transaction");
  }
  executorSavepoints.add(tx);
  const name = sql.identifier(
    `stella_scope_${Bun.randomUUIDv7().replaceAll("-", "")}`,
  );
  let phase: ExecutorSavepointError["phase"] = "setup";
  try {
    const scope = await Result.tryPromise({
      try: async () =>
        await withSharedTransactionTimeoutRestoration(tx, async (previous) => {
          await tx.execute(sql`SAVEPOINT ${name}`);
          const outcome = await Result.tryPromise({
            try: async () => await run(previous),
            catch: (cause) =>
              new ExecutorSavepointError({
                message: "Executor savepoint callback failed",
                cause,
                phase: "callback",
              }),
          });
          phase = "cleanup";
          if (outcome.isErr() || outcome.value.type === "rollback") {
            await tx.execute(sql`ROLLBACK TO SAVEPOINT ${name}`);
          }
          await tx.execute(sql`RELEASE SAVEPOINT ${name}`);
          if (outcome.isErr()) {
            return abortTransaction(outcome.error);
          }
          return outcome.value.value;
        }),
      catch: (cause) =>
        cause instanceof ExecutorSavepointError
          ? cause
          : new ExecutorSavepointError({
              message: `Executor savepoint ${phase} failed`,
              cause,
              phase,
            }),
    });
    return scope;
  } finally {
    executorSavepoints.delete(tx);
  }
};

/** Own a fresh database transaction or track a native nested savepoint. */
export const withAggregateSavepoint = async <Tx extends object, T>(
  tx: {
    transaction: <Value>(
      run: (savepoint: Tx) => Promise<Value>,
    ) => Promise<Value>;
  },
  run: (savepoint: Tx) => Promise<T>,
): Promise<T> => {
  // Only native transaction handles expose rollback. A reusable database
  // must never enter the per-transaction history registry.
  if (!("rollback" in tx)) {
    return await withAggregateTransaction(tx, run);
  }
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
// Most row aggregates are one row found by id inside a single owning scope.
const byIdWithin = (
  table: string,
  id: string,
  scopeColumn: string,
  scopeValue: string,
): RowResource => ({
  table,
  columns: ["id"],
  values: [id],
  scopeColumns: [scopeColumn],
  scopeValues: [scopeValue],
});
// A root row found by its own key, with no owning scope to check.
const byUnscopedKey = (
  table: string,
  column: string,
  value: string | number,
): RowResource => ({
  table,
  columns: [column],
  values: [value],
  scopeColumns: [],
  scopeValues: [],
});
const memberCleanupRowResource = (
  id: AggregateIdentities["memberCleanup"],
): RowResource => {
  switch (id.type) {
    case "organization-member":
      return byIdWithin("member", id.id, "organization_id", id.organizationId);
    case "workspace-member":
      return byIdWithin(
        "workspace_members",
        id.id,
        "workspace_id",
        id.workspaceId,
      );
    default:
      id satisfies never;
      return panic("Unknown member cleanup resource");
  }
};
type AuxiliaryRowIdentityOptions = Extract<
  RowIdentityOptions,
  {
    aggregate:
      | "accountDeletionRequest"
      | "desktopMembership"
      | "memory"
      | "searchProjectionRepair";
  }
>;

const auxiliaryRowResource = (
  options: AuxiliaryRowIdentityOptions,
): RowResource => {
  switch (options.aggregate) {
    case "accountDeletionRequest":
      return {
        table: "account_deletion_requests",
        columns: ["id"],
        values: [options.id],
        scopeColumns: [],
        scopeValues: [],
      };
    case "desktopMembership":
      return {
        table: "member",
        columns: ["user_id", "organization_id"],
        values: [options.id.userId, options.id.organizationId],
        scopeColumns: [],
        scopeValues: [],
      };
    case "memory":
      return byIdWithin(
        "ai_memories",
        options.id.id,
        "organization_id",
        options.id.organizationId,
      );
    case "searchProjectionRepair":
      return {
        table: "search_projection_repair_queue",
        columns: ["kind", "source_id", "revision"],
        values: [options.id.kind, options.id.sourceId, options.id.revision],
        scopeColumns: [],
        scopeValues: [],
      };
    default:
      options satisfies never;
      return panic("Unknown auxiliary row aggregate");
  }
};

const rowResource = (options: RowIdentityOptions): RowResource => {
  switch (options.aggregate) {
    case "requestReceipt":
      return {
        table: "request_idempotency_receipts",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["organization_id", "user_id"],
        scopeValues: [options.id.organizationId, options.id.userId],
      };
    case "account":
    case "organization":
      return byUnscopedKey(
        options.aggregate === "account" ? "user" : "organization",
        "id",
        options.id,
      );
    case "accountExport":
      return byIdWithin(
        "account_exports",
        options.id.id,
        "user_id",
        options.id.userId,
      );
    case "accountDeletionRequest":
    case "desktopMembership":
    case "memory":
    case "searchProjectionRepair":
      return auxiliaryRowResource(options);
    case "searchHistory":
      return {
        table: "search_history_owners",
        columns: ["organization_id", "user_id"],
        values: [options.id.organizationId, options.id.userId],
        scopeColumns: [],
        scopeValues: [],
      };
    case "desktopCredential":
      return byIdWithin(
        "apikey",
        options.id.id,
        "reference_id",
        options.id.userId,
      );
    case "chatMessage":
      return byIdWithin(
        "chat_messages",
        options.id.id,
        "thread_id",
        options.id.threadId,
      );
    case "workspace":
      return byIdWithin(
        "workspaces",
        options.id.id,
        "organization_id",
        options.id.organizationId,
      );
    case "run":
      return byIdWithin(
        "flow_runs",
        options.id.id,
        "workspace_id",
        options.id.workspaceId,
      );
    case "currentStep":
      return byIdWithin(
        "flow_run_steps",
        options.id.id,
        "workspace_id",
        options.id.workspaceId,
      );
    case "obligation":
      return {
        table: "work_obligations",
        columns: ["entity_id"],
        values: [options.id.id],
        scopeColumns: ["workspace_id"],
        scopeValues: [options.id.workspaceId],
      };
    case "folioCollabRoom":
      return byIdWithin(
        "folio_collab_rooms",
        options.id.id,
        "workspace_id",
        options.id.workspaceId,
      );
    case "entity":
      return byIdWithin(
        "entities",
        options.id.id,
        "workspace_id",
        options.id.workspaceId,
      );
    case "entityVersion":
      return {
        table: "entity_versions",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["workspace_id"],
        scopeValues: [options.id.workspaceId],
      };
    case "field":
      return {
        table: "fields",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["workspace_id"],
        scopeValues: [options.id.workspaceId],
      };
    case "signal":
      return byIdWithin(
        "signals",
        options.id.id,
        "organization_id",
        options.id.organizationId,
      );
    case "schedulerClaim":
      return byUnscopedKey("scheduler_jobs", "id", options.id.id);
    case "definition":
      return byIdWithin(
        "flow_definitions",
        options.id.id,
        "organization_id",
        options.id.organizationId,
      );
    case "processingClaim":
      return byIdWithin(
        "document_processing_runs",
        options.id.id,
        "workspace_id",
        options.id.workspaceId,
      );
    case "scoutCensus":
      return byIdWithin(
        "scout_runs",
        options.id.id,
        "organization_id",
        options.id.organizationId,
      );
    case "chatThread":
      return {
        table: "chat_threads",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["organization_id", "user_id"],
        scopeValues: [options.id.organizationId, options.id.userId],
      };
    case "readerAnswer":
      return {
        table: "legal_reader_answers",
        columns: ["id"],
        values: [options.id.id],
        scopeColumns: ["organization_id", "user_id"],
        scopeValues: [options.id.organizationId, options.id.userId],
      };
    case "readerAnswerMessage":
      return byIdWithin(
        "legal_reader_answer_messages",
        options.id.id,
        "answer_id",
        options.id.answerId,
      );
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
    case "signingSession":
      return byIdWithin(
        "pdf_signing_sessions",
        options.id.id,
        "workspace_id",
        options.id.workspaceId,
      );
    case "memberCleanup":
      return memberCleanupRowResource(options.id);
    default:
      options satisfies never;
      return panic("Unknown row aggregate");
  }
};
type PhysicalRowLockOptions = {
  aggregate: RowIdentityOptions["aggregate"];
  table: string;
  values: readonly (string | number)[];
  mode: RowLockMode;
};
const physicalRowLock = ({
  aggregate,
  table,
  values,
  mode,
}: PhysicalRowLockOptions): HeldLock => {
  const key = JSON.stringify(["row", table, ...values]);
  return {
    rank: AGGREGATE_LOCKS[aggregate].rank,
    key,
    orderKey: JSON.stringify([aggregate, table, ...values]),
    mode,
  };
};
const rowLock = (options: RowIdentityOptions, mode: RowLockMode): HeldLock => {
  const { table, values } = rowResource(options);
  const lock = physicalRowLock({
    aggregate: options.aggregate,
    table,
    values,
    mode,
  });
  return options.aggregate === "signingSession"
    ? {
        ...lock,
        orderKey: JSON.stringify([
          options.aggregate,
          table,
          options.id.organizationId,
          ...values,
        ]),
      }
    : lock;
};

// A batch is ordered twice: by SQL (COLLATE "C", byte order) and by the
// history (code-unit order). The two agree on the ASCII ID alphabet, so batch
// IDs outside it are refused. Single-row locks have no SQL ordering.
const assertBatchIdAlphabet = (id: string): void => {
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) {
    panic("Aggregate parent batch IDs must use the ASCII ID alphabet");
  }
};

const parentRowSchema = v.object({ id: v.string() });
type AggregateParentBatchOptions = {
  tx: ExecuteTransaction;
  organizationIds: readonly SafeId<"organization">[];
  workspaceIds?: readonly SafeId<"workspace">[];
  mode: RowLockMode;
};

/**
 * Parent batches ascend by registered rank, then immutable primary key.
 * Workspace batches need no organization ID: rank decides lock order, while
 * the transaction's RLS scope decides which rows are visible.
 */
export const withAggregateParentBatch = async ({
  tx,
  organizationIds,
  workspaceIds = [],
  mode,
}: AggregateParentBatchOptions) => {
  const history = lockHistory(tx);
  assertAggregateLevelAvailable(history);
  for (const id of [...organizationIds, ...workspaceIds]) {
    assertBatchIdAlphabet(id);
  }
  const acquire = async (
    aggregate: "organization" | "workspace",
    requestedIds: readonly string[],
  ) => {
    // PostgreSQL returns UUIDs in canonical lowercase; normalize first so the
    // returned rows match their declared lock identities.
    const canonicalIds =
      aggregate === "workspace"
        ? requestedIds.map((id) => id.toLowerCase())
        : requestedIds;
    const ids = [...new Set(canonicalIds)].toSorted(compareCodeUnit);
    if (ids.length === 0) {
      return [];
    }
    assertAggregateLevelAvailable(history);
    const table = aggregate === "organization" ? organization : workspaces;
    // UUID columns cannot carry a collation; their canonical text is ASCII.
    const orderedId =
      aggregate === "organization" ? sql`${table.id}` : sql`${table.id}::text`;
    const locks = new Map(
      ids.map((id) => [
        id,
        physicalRowLock({
          aggregate,
          table: getTableName(table),
          values: [id],
          mode,
        }),
      ]),
    );
    for (const lock of locks.values()) {
      assertLockOrder(history, lock, "block");
    }
    history.status = "acquiring";
    const rows = executedRows(
      await tx.execute(sql`
    SELECT id FROM ${table}
    WHERE ${table.id} IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    ORDER BY ${orderedId} COLLATE "C" ${sql.raw(`FOR ${mode.toUpperCase()}`)}
  `),
    );
    const returnedIds = rows.map((row) => v.parse(parentRowSchema, row).id);
    for (const id of returnedIds) {
      retainLock(
        history,
        locks.get(id) ?? panic("Parent batch returned an undeclared row"),
      );
    }
    completeAcquisition(history);
    return returnedIds;
  };
  const organizations = await acquire("organization", organizationIds);
  const matters = await acquire("workspace", workspaceIds);
  return {
    organizationIds: new Set(organizations.map(brandPersistedOrganizationId)),
    workspaceIds: new Set(matters.map(brandPersistedWorkspaceId)),
  };
};
type AggregateEntityBatchOptions = {
  tx: Transaction;
  ids: readonly AggregateIdentities["entity"][];
  mode: RowLockMode;
  limit: number;
};

/** Bounded entity snapshots keep one ordered acquisition for a repair batch. */
export const withAggregateEntityBatch = async ({
  tx,
  ids,
  mode,
  limit,
}: AggregateEntityBatchOptions) => {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    panic("Aggregate entity batch requires a positive integer limit");
  }
  const identities = new Map<string, AggregateIdentities["entity"]>();
  for (const id of ids) {
    const previous = identities.get(id.id);
    if (previous !== undefined && previous.workspaceId !== id.workspaceId) {
      panic("Aggregate entity batch declares conflicting tenant identities");
    }
    identities.set(id.id, id);
  }
  const ordered = [...identities.values()].toSorted((left, right) =>
    compareCodeUnit(left.id, right.id),
  );
  if (ordered.length === 0) {
    return [];
  }
  const history = lockHistory(tx);
  assertAggregateLevelAvailable(history);
  const locks = new Map(
    ordered.map((id) => [id.id, rowLock({ aggregate: "entity", id }, mode)]),
  );
  for (const lock of locks.values()) {
    assertLockOrder(history, lock, "block");
  }
  history.status = "acquiring";
  const rows = await tx
    .select({
      id: entities.id,
      workspaceId: entities.workspaceId,
      currentVersionId: entities.currentVersionId,
      readOnly: entities.readOnly,
    })
    .from(entities)
    .where(
      or(
        ...ordered.map((id) =>
          and(eq(entities.id, id.id), eq(entities.workspaceId, id.workspaceId)),
        ),
      ),
    )
    .orderBy(sql`${entities.id}::text COLLATE "C"`)
    .limit(limit)
    .for(mode);
  for (const lock of locks.values()) {
    retainReservation(history, lock);
  }
  for (const row of rows) {
    const identity =
      identities.get(row.id) ??
      panic("Aggregate entity batch returned an undeclared row");
    if (row.workspaceId !== identity.workspaceId) {
      panic("Aggregate entity batch returned an undeclared tenant");
    }
    retainLock(
      history,
      locks.get(row.id) ?? panic("Missing aggregate batch lock"),
    );
  }
  completeAcquisition(history);
  return rows;
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
    case "organizationObjectIntent":
      return {
        first: sql`${ORGANIZATION_OBJECT_INTENT_LOCK_NAMESPACE}::integer`,
        second: sql`hashtext(${options.id})`,
        order: [options.aggregate, options.id],
      };
    case "legislationAmendmentWork":
      return {
        first: sql`${0x0f_10_cc_ad}::integer`,
        second: sql`hashtext(${JSON.stringify([options.id.sourceId, options.id.eli, options.id.language])})`,
        order: [
          options.aggregate,
          options.id.sourceId,
          options.id.eli,
          options.id.language,
        ],
      };
    case "chatOwnerStoredContentEgress": {
      const key = chatOwnerStoredContentEgressKey(options.id);
      return {
        first: sql`${CHAT_OWNER_STORED_CONTENT_EGRESS_LOCK_NAMESPACE}::integer`,
        second: sql`hashtext(${key})`,
        order: [options.aggregate, key],
      };
    }
    case "chatStoredContentEgress":
      return {
        first: sql`${CHAT_STORED_CONTENT_EGRESS_LOCK_NAMESPACE}::integer`,
        second: sql`hashtext(${options.id})`,
        order: [options.aggregate, options.id],
      };
    case "desktopBatch":
      return {
        first: sql`${0x0f_10_cc_ac}::integer`,
        second: sql`hashtext(${JSON.stringify([options.id.organizationId, options.id.userId, options.id.idempotencyKey])})`,
        order: [
          options.aggregate,
          options.id.organizationId,
          options.id.userId,
          options.id.idempotencyKey,
        ],
      };
    case "sampleCase":
      return {
        first: sql`hashtext('lists.sample-case')`,
        second: sql`hashtext(${options.id.workspaceId})`,
        order: [options.aggregate, options.id.workspaceId],
      };
    case "professionalUseAcceptance":
      return {
        first: sql`hashtext('professional-use')`,
        second: sql`hashtext(${options.id.userId})`,
        order: [options.aggregate, options.id.userId],
      };
    case "automatedFlowRunCap":
      return {
        first: sql`${0x0f_10_cc_a9}::integer`,
        second: sql`hashtext(${options.id})`,
        order: [options.aggregate, options.id],
      };
    case "contactCapacity":
      return {
        first: sql`hashtext('contact_capacity')`,
        second: sql`hashtext(${options.id.organizationId})`,
        order: [options.aggregate, options.id.organizationId],
      };
    case "chatToolGrants":
      return {
        first: sql`hashtext('chat.tool-grants')`,
        second: sql`hashtext(${JSON.stringify([options.id.organizationId, options.id.userId])})`,
        order: [
          options.aggregate,
          options.id.organizationId,
          options.id.userId,
        ],
      };
    case "fileComparisonCapacity":
      return {
        first: sql`${0x0f_10_cc_b2}::integer`,
        second: sql`hashtext(${options.id.organizationId})`,
        order: [options.aggregate, options.id.organizationId],
      };
    case "billingCodeCapacity":
      return {
        first: sql`hashtext('billing-code-capacity')`,
        second: sql`hashtext(${options.id.workspaceId})`,
        order: [options.aggregate, options.id.workspaceId],
      };
    case "expenseCapacity":
      return {
        first: sql`hashtext('expense-capacity')`,
        second: sql`hashtext(${options.id.workspaceId})`,
        order: [options.aggregate, options.id.workspaceId],
      };
    case "rateTableWorkspace":
      return {
        first: sql`hashtext('rate-table-workspace')`,
        second: sql`hashtext(${options.id.workspaceId})`,
        order: [options.aggregate, options.id.workspaceId],
      };
    case "mcpOAuthState":
      return {
        first: sql`${0x4d_43_50_4f}::integer`,
        // A JSON array keeps the three ids apart without a separator they
        // could contain; PostgreSQL text parameters cannot carry NUL.
        second: sql`hashtext(${JSON.stringify([
          options.id.organizationId,
          options.id.connectorId,
          options.id.userId,
        ])})`,
        order: [
          options.aggregate,
          options.id.organizationId,
          options.id.connectorId,
          options.id.userId,
        ],
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
    case "readerAnnotation":
      return {
        first: sql`${READER_ANNOTATION_LOCK_NAMESPACE}::integer`,
        second: sql`hashtext(${JSON.stringify([options.id.userId, options.id.id])})`,
        order: [
          options.aggregate,
          options.id.organizationId,
          options.id.userId,
          options.id.id,
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
        first: sql`${0x0f_10_cc_ab}::integer`,
        second: sql`hashtext(${options.id.definitionId})`,
        order: [options.aggregate, options.id.definitionId],
      };
    case "caseLawRepublication":
      return {
        first: sql`${0x0f_10_cc_ae}::integer`,
        second: sql`0::integer`,
        order: [options.aggregate, options.id],
      };
    default:
      options satisfies never;
      return panic("Unknown advisory aggregate");
  }
};

type AggregateSessionConnection = {
  unsafe: (query: string, params?: unknown[]) => PromiseLike<unknown>;
};

/**
 * Hold the thread's stored-content egress fence on one physical session.
 * Transaction writers use the same key through `withAggregateLock`; holding
 * this session lock across provider I/O linearizes raw egress with a thread's
 * irreversible switch to anonymized mode without keeping a transaction open.
 */
export const withChatStoredContentEgressSessionLock = async <T>({
  connection,
  organizationId,
  threadId,
  userId,
  work,
}: {
  connection: AggregateSessionConnection;
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  work: () => Promise<T>;
}): Promise<T> => {
  const ownerKey = chatOwnerStoredContentEgressKey({ organizationId, userId });
  let ownerAcquired = false;
  let threadAcquired = false;
  try {
    await connection.unsafe(
      "SELECT pg_advisory_lock($1::integer, hashtext($2::text))",
      [CHAT_OWNER_STORED_CONTENT_EGRESS_LOCK_NAMESPACE, ownerKey],
    );
    ownerAcquired = true;
    await connection.unsafe(
      "SELECT pg_advisory_lock($1::integer, hashtext($2::text))",
      [CHAT_STORED_CONTENT_EGRESS_LOCK_NAMESPACE, threadId],
    );
    threadAcquired = true;
    return await work();
  } finally {
    if (threadAcquired) {
      const rows = await connection.unsafe(
        "SELECT pg_advisory_unlock($1::integer, hashtext($2::text)) AS released",
        [CHAT_STORED_CONTENT_EGRESS_LOCK_NAMESPACE, threadId],
      );
      let released: unknown;
      if (Array.isArray(rows)) {
        const values: unknown[] = rows;
        released = values.at(0);
      }
      if (!isRecord(released) || released["released"] !== true) {
        panic("Chat stored-content egress lock was not held at release");
      }
    }
    if (ownerAcquired) {
      const rows = await connection.unsafe(
        "SELECT pg_advisory_unlock($1::integer, hashtext($2::text)) AS released",
        [CHAT_OWNER_STORED_CONTENT_EGRESS_LOCK_NAMESPACE, ownerKey],
      );
      let released: unknown;
      if (Array.isArray(rows)) {
        const values: unknown[] = rows;
        released = values.at(0);
      }
      if (!isRecord(released) || released["released"] !== true) {
        panic("Chat owner stored-content egress lock was not held at release");
      }
    }
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
  if (!isRowLockOptions(options)) {
    const resource = advisoryResource(options);
    const logicalKey = JSON.stringify(resource.order);
    const mode = options.mode ?? "exclusive";
    const held = allHeldLocks(history);
    let key = knownAdvisoryKey(history, logicalKey);
    // Resolve hash aliases before deciding shared coverage or refusing an upgrade.
    if (
      key === logicalKey &&
      held.some(
        (previous) =>
          previous.mode === "advisory shared" ||
          (mode === "shared" && previous.mode === "advisory exclusive"),
      )
    ) {
      history.status = "acquiring";
      const metadata = executedRows(
        await tx.execute(
          sql`SELECT ${resource.first} AS key1, ${resource.second} AS key2`,
        ),
      );
      key = physicalAdvisoryKey(metadata.at(0));
      completeAcquisition(history);
    }
    const lock = {
      rank: AGGREGATE_LOCKS[aggregate].rank,
      key,
      orderKey: logicalKey,
      mode: `advisory ${mode}`,
    } as const;
    if (
      mode === "shared" &&
      held.some(
        (previous) =>
          previous.key === key && modeCovers(previous.mode, lock.mode),
      )
    ) {
      history.aliases.set(logicalKey, key);
      retainReservation(history, lock);
      return { status: "locked" };
    }
    if (
      mode === "exclusive" &&
      held.some(
        (previous) =>
          previous.key === key && previous.mode === "advisory shared",
      )
    ) {
      return abortTransaction(
        new AggregateLockUpgradeRefused({
          aggregate,
          message:
            "Take the exclusive advisory mode before holding the shared mode",
        }),
      );
    }
    assertLockOrder(history, lock, wait);
    const statements = {
      shared: {
        block: sql`pg_advisory_xact_lock_shared(${resource.first}, ${resource.second})`,
        nowait: sql`pg_try_advisory_xact_lock_shared(${resource.first}, ${resource.second})`,
      },
      exclusive: {
        block: sql`pg_advisory_xact_lock(${resource.first}, ${resource.second})`,
        nowait: sql`pg_try_advisory_xact_lock(${resource.first}, ${resource.second})`,
      },
    } as const satisfies Record<
      AdvisoryLockMode,
      Record<"block" | "nowait", SQL>
    >;
    history.status = "acquiring";
    const rows = executedRows(
      await tx.execute(
        sql`SELECT ${resource.first} AS key1, ${resource.second} AS key2, ${statements[mode][wait]} AS acquired`,
      ),
    );
    const row = rows.at(0);
    const physicalKey = physicalAdvisoryKey(row);
    if (
      wait === "nowait" &&
      (!isRecord(row) || typeof row["acquired"] !== "boolean")
    ) {
      panic("Missing advisory acquisition outcome");
    }
    const acquired =
      wait === "block" || (isRecord(row) && row["acquired"] === true);
    if (acquired) {
      history.aliases.set(logicalKey, physicalKey);
      retainLock(history, { ...lock, key: physicalKey });
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

/** The queue claim owns this nonblocking row-lock clause. */
export const chatCompactionQueueClaimLock = () => sql`FOR UPDATE SKIP LOCKED`;

type OpenSigningPageOptions = {
  tx: Transaction;
  sessions: readonly AggregateIdentities["signingSession"][];
};

/** Lock and recheck a discovered page; a concurrently closed session is no longer eligible. */
export const lockOpenSigningPage = async ({
  tx,
  sessions,
}: OpenSigningPageOptions) => {
  if (sessions.length === 0) {
    return [];
  }
  const history = lockHistory(tx);
  assertAggregateLevelAvailable(history);
  const ordered = sessions.toSorted((left, right) =>
    compareCodeUnit(left.id, right.id),
  );
  const locks = new Map(
    ordered.map((session) => [
      session.id,
      rowLock({ aggregate: "signingSession", id: session }, "update"),
    ]),
  );
  for (const lock of locks.values()) {
    assertLockOrder(history, lock, "block");
  }
  history.status = "acquiring";
  const rows = await tx.execute(sql`
    SELECT id, workspace_id FROM ${pdfSigningSessions}
    WHERE (id, workspace_id) IN (${sql.join(
      ordered.map(
        (session) => sql`(${session.id}::uuid, ${session.workspaceId}::uuid)`,
      ),
      sql`, `,
    )})
      AND status = 'open'
    ORDER BY id FOR UPDATE
  `);
  const heldIds = new Set(
    executedRows(rows).map((row) => v.parse(parentRowSchema, row).id),
  );
  for (const session of ordered) {
    if (heldIds.has(session.id)) {
      retainLock(
        history,
        locks.get(session.id) ?? panic("Missing signing session lock"),
      );
    }
  }
  completeAcquisition(history);
  return ordered.filter(({ id }) => heldIds.has(id));
};

type AggregateLockableQuery<Row> = {
  for: (mode: RowLockMode, config?: LockConfig) => PromiseLike<Row[]>;
  toSQL: () => { sql: string };
  as: (alias: string) => Subquery;
};
type DocumentSourceChild = Extract<
  RowIdentityOptions,
  { aggregate: "entityVersion" | "field" }
>;
type AggregateQueryIdentity =
  | (Extract<RowIdentityOptions, { aggregate: "entity" }> & {
      children?: readonly DocumentSourceChild[];
    })
  | (Exclude<RowIdentityOptions, { aggregate: "entity" }> & {
      children?: undefined;
    });

type AggregateRowQueryOptions<Row> = AggregateQueryIdentity & {
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

type RequestReceiptPrincipalRowsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** Membership cleanup may hold later-ranked matter locks, so this entire set must be nonblocking. */
export const lockRequestReceiptPrincipalRows = async ({
  tx,
  organizationId,
  userId,
}: RequestReceiptPrincipalRowsOptions): Promise<
  AggregateRowsResult<{ id: SafeId<"requestIdempotencyReceipt"> }>
> => {
  const result = await Result.tryPromise(
    async () =>
      await withAggregateSavepoint(tx, async (child) => {
        const history = lockHistory(child);
        assertAggregateLevelAvailable(history);
        history.status = "acquiring";
        const rows = await child
          .select({ id: requestIdempotencyReceipts.id })
          .from(requestIdempotencyReceipts)
          .where(
            and(
              eq(requestIdempotencyReceipts.organizationId, organizationId),
              eq(requestIdempotencyReceipts.userId, userId),
            ),
          )
          .for("update", { noWait: true });
        for (const { id } of rows) {
          const requested = rowLock(
            { aggregate: "requestReceipt", id: { id, organizationId, userId } },
            "update",
          );
          assertLockOrder(history, requested, "nowait");
          retainLock(history, requested);
        }
        completeAcquisition(history);
        return rows;
      }),
  );
  if (result.isOk()) {
    return {
      status: result.value.length === 0 ? "missing" : "locked",
      rows: result.value,
    };
  }
  if (getPgErrorCode(result.error) === PG_ERROR.LOCK_NOT_AVAILABLE) {
    return {
      status: "busy",
      error: new AggregateLockBusy({
        aggregate: "requestReceipt",
        message: "The requested receipt principal is busy",
      }),
    };
  }
  return abortTransaction(result.error.cause);
};

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
    tables: [
      table.value,
      ...tokens.flatMap((token, index) => {
        if (token.kind !== "word" || token.value !== "join") {
          return [];
        }
        const joined = tokens.at(index + 1);
        if (joined === undefined || joined.kind === "symbol") {
          return panic("Unsupported aggregate JOIN target");
        }
        return [joined.value];
      }),
    ],
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
export function withAggregateRowQuery<Row>(
  options: AggregateRowQueryOptions<Row> & { wait?: "block" },
): Promise<Exclude<AggregateRowsResult<Row>, { status: "busy" }>>;
export function withAggregateRowQuery<Row>(
  options: AggregateRowQueryOptions<Row>,
): Promise<AggregateRowsResult<Row>>;
export async function withAggregateRowQuery<Row>(
  options: AggregateRowQueryOptions<Row>,
): Promise<AggregateRowsResult<Row>> {
  const history = lockHistory(options.tx);
  assertAggregateLevelAvailable(history);
  const wait = options.wait ?? "block";
  const children = options.children;
  const identities: RowIdentityOptions[] = [options];
  if (children !== undefined) {
    identities.push(...children);
  }
  const requests = identities.map((identity) =>
    rowLock(identity, options.mode),
  );
  for (const [index, requested] of requests.entries()) {
    assertLockOrder(history, requested, wait);
    const previous = requests.at(index - 1);
    if (
      index > 0 &&
      previous !== undefined &&
      requested.rank <= previous.rank
    ) {
      panic("Aggregate child locks must ascend by registered rank");
    }
  }
  const acquire = async (
    tx: Transaction,
  ): Promise<AggregateRowsResult<Row>> => {
    const queryHistory = lockHistory(tx);
    assertAggregateLevelAvailable(queryHistory);
    const query = options.select(tx);
    const primaryResource = rowResource(options);
    const table = primaryResource.table;
    const target = aggregateSelectTarget(query.toSQL().sql);
    if (target.table !== table) {
      panic("Aggregate query target does not match its registered resource");
    }
    if (target.filtered) {
      panic("Pass additional aggregate predicates through the where option");
    }
    const resources = identities.map(rowResource);
    const of = options.lockConfig?.of;
    let lockConfig = options.lockConfig;
    if (children !== undefined && children.length > 0) {
      if (of !== undefined) {
        panic("Aggregate child query owns its lock targets");
      }
      const tables = [
        entities,
        ...children.map((child) => {
          switch (child.aggregate) {
            case "entityVersion":
              return entityVersions;
            case "field":
              return fields;
            default:
              return panic("Unknown aggregate source child");
          }
        }),
      ];
      const registeredTables = resources.map(
        ({ table: targetTable }) => targetTable,
      );
      const joinedTargets = target.tables.filter((name) =>
        registeredTables.includes(name),
      );
      if (JSON.stringify(joinedTargets) !== JSON.stringify(registeredTables)) {
        panic("Aggregate child query joins must follow registered rank");
      }
      lockConfig = { ...options.lockConfig, of: tables };
    } else if (of !== undefined) {
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
    const selection = getColumns(query.as("aggregate_projection"));
    const projections = resources.map((resource) =>
      registeredProjection(selection, resource),
    );
    const predicate =
      and(
        ...resources.flatMap((resource) => {
          const columns = [...resource.columns, ...resource.scopeColumns];
          const values = [...resource.values, ...resource.scopeValues];
          return columns.map(
            (column, index) =>
              sql`${sql.identifier(resource.table)}.${sql.identifier(column)} = ${values.at(index) ?? panic("Missing aggregate row key")}`,
          );
        }),
        options.where,
      ) ?? panic("Missing registered aggregate predicate");
    const scopedQuery = query.where(predicate);
    aggregateSelectTarget(scopedQuery.toSQL().sql);
    assertAggregateLevelAvailable(queryHistory);
    queryHistory.status = "acquiring";
    const rows = await scopedQuery.for(
      options.mode,
      wait === "nowait" ? { ...lockConfig, noWait: true } : lockConfig,
    );
    // PostgreSQL may lock a snapshot-matching row and omit it after rechecking
    // an updated predicate. Reserve its order, but only returned rows confirm
    // held coverage for later acquisitions of the same identity.
    // https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
    for (const [index, requested] of requests.entries()) {
      retainReservation(queryHistory, requested);
      const resource =
        resources.at(index) ?? panic("Missing aggregate resource");
      const projection =
        projections.at(index) ?? panic("Missing aggregate projection");
      const projected = rows.map((row) => projectedRowValues(row, projection));
      // Record every locked target before validating the returned identities.
      for (const row of projected) {
        const physicalValues = projectedPhysicalIdentity(row);
        retainLock(queryHistory, {
          ...requested,
          key: JSON.stringify(["row", resource.table, ...physicalValues]),
          orderKey: JSON.stringify([
            identities.at(index)?.aggregate,
            resource.table,
            ...physicalValues,
          ]),
        });
      }
    }
    completeAcquisition(queryHistory);
    for (const projection of projections) {
      validateProjectedRows(
        rows.map((row) => projectedRowValues(row, projection)),
      );
    }
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
}

type AutomatedFlowRunCapLockOptions = {
  definitionId: SafeId<"flowDefinition">;
  database: Pick<Transaction, "transaction">;
};

/** Own the cap transaction so the decision and insert share its advisory fence. */
export const withAutomatedFlowRunCapLock = async <T>(
  { definitionId, database }: AutomatedFlowRunCapLockOptions,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await withAggregateTransaction(database, async (tx) => {
    await withAggregateLock({
      aggregate: "automatedFlowRunCap",
      id: definitionId,
      tx,
    });
    return await run(tx);
  });

type DecisionCitationStatsLocksOptions = {
  tx: ExecuteTransaction;
  decisionIds: readonly SafeId<"caseLawDecision">[];
};

/**
 * Lock before comparing so a concurrent writer cannot create false drift.
 * Every existing batch row, published or listing-only, is locked before any
 * stripe: refresh rebuilds each supplied decision, and a visibility update
 * holds its own row while it waits for stripes.
 */
const lockedDecisionRowSchema = v.object({ id: v.string() });

/** Coordinate republication linking with alias discovery during erasure. */
export const lockCaseLawRepublication = async ({
  tx,
  mode,
}: {
  tx: ExecuteTransaction;
  mode: AdvisoryLockMode;
}): Promise<void> => {
  await withAggregateLock({
    aggregate: "caseLawRepublication",
    id: "global",
    mode,
    tx,
  });
};

/** Lock decision rows in stable order before reading mutation preconditions. */
export const lockCaseLawDecisionRows = async ({
  tx,
  decisionIds,
}: {
  tx: ExecuteTransaction;
  decisionIds: readonly SafeId<"caseLawDecision">[];
}): Promise<void> => {
  if (decisionIds.length === 0) {
    return;
  }
  await tx.execute(sql`
    SELECT id FROM case_law_decisions
    WHERE id IN (${sql.join(
      decisionIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    ORDER BY id
    FOR UPDATE
  `);
};

/** Acquire one replay reservation after its checkpoint and before its decision. */
export const lockCaseLawReplayBatch = async ({
  tx,
  id,
  predicate,
}: {
  tx: Transaction;
  id: string;
  predicate: SQL | undefined;
}) =>
  (
    await tx
      .select()
      .from(caseLawReplayBatches)
      .where(and(eq(caseLawReplayBatches.id, id), predicate))
      .for("update")
      .limit(1)
  ).at(0);

type ReplayPendingBatchLockOptions = {
  tx: Transaction;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  cursor: string | null;
};

/** Select one due batch while retaining the checkpoint's deterministic order. */
export const lockCaseLawReplayPendingBatch = async ({
  tx,
  sourceId,
  now,
  cursor,
}: ReplayPendingBatchLockOptions) =>
  (
    await tx
      .select()
      .from(caseLawReplayBatches)
      .where(
        and(
          eq(caseLawReplayBatches.sourceId, sourceId),
          inArray(caseLawReplayBatches.status, ["reserved", "retry-exhausted"]),
          or(
            isNull(caseLawReplayBatches.retryAt),
            lte(caseLawReplayBatches.retryAt, sql`${now}::timestamptz`),
          ),
        ),
      )
      .orderBy(
        ...(cursor === null
          ? []
          : [
              sql`CASE WHEN ${caseLawReplayBatches.firstDecisionId} > ${cursor}::uuid THEN 0 ELSE 1 END`,
            ]),
        asc(caseLawReplayBatches.firstDecisionId),
        asc(caseLawReplayBatches.id),
      )
      .for("update")
      .limit(1)
  ).at(0);

type ReplayCompactionQueryOptions = { cutoff: Date; limit: number };
export const buildCaseLawReplayCompactionQuery = (
  tx: Transaction,
  { cutoff, limit }: ReplayCompactionQueryOptions,
) =>
  tx
    .select({
      id: caseLawReplayBatches.id,
    })
    .from(caseLawReplayBatches)
    .where(
      and(
        isNotNull(caseLawReplayBatches.supersededAt),
        lte(caseLawReplayBatches.supersededAt, sql`${cutoff}::timestamptz`),
      ),
    )
    .orderBy(
      asc(caseLawReplayBatches.supersededAt),
      asc(caseLawReplayBatches.id),
    )
    .limit(limit)
    .for("update");

/**
 * The citing decisions a reviewed-label run admits: the unredacted ones among
 * `decisionIds`. A write (`lock: true`) holds them FOR SHARE in id order until
 * it commits: a redaction updates the decision row, so it either waits for the
 * write and then erases what it stored, or commits first and the decision is
 * not returned. A plan writes nothing and may run read-only, so it reads them
 * without a lock.
 */
export const lockUnredactedCitingDecisions = async ({
  tx,
  decisionIds,
  lock,
}: {
  tx: ExecuteTransaction;
  decisionIds: readonly string[];
  lock: boolean;
}): Promise<Set<string>> => {
  if (decisionIds.length === 0) {
    return new Set();
  }
  const rows = executedRows(
    await tx.execute(sql`
      SELECT id::text AS id FROM case_law_decisions
      WHERE redacted_at IS NULL
        AND id IN (${sql.join(
          decisionIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      ORDER BY id${lock ? sql` FOR SHARE` : sql``}
    `),
  );
  return new Set(rows.map((row) => v.parse(lockedDecisionRowSchema, row).id));
};

export const withDecisionCitationStatsLocks = async ({
  tx,
  decisionIds,
}: DecisionCitationStatsLocksOptions) => {
  await tx.execute(sql`
    SELECT id FROM case_law_decisions
    WHERE id IN (${sql.join(
      decisionIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    ORDER BY id FOR NO KEY UPDATE
  `);
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(19053, key) FROM (
      SELECT DISTINCT (hashtextextended('decision-citation-stats:' || id::text, 0) & 127)::integer AS key
      FROM case_law_decisions WHERE id IN (${sql.join(
        decisionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY key
    ) anchors
  `);
};

type LockBillingCapArrangementsOptions<
  Usage extends Record<string, SQL<string>>,
> = {
  workspaceIds: readonly SafeId<"workspace">[];
  usageProjection: Usage;
};

/** Fence matter keys together before locking capped arrangements and their usage snapshot. */
export const lockBillingCapArrangements = async <
  Usage extends Record<string, SQL<string>>,
>(
  tx: Transaction,
  { workspaceIds, usageProjection }: LockBillingCapArrangementsOptions<Usage>,
) => {
  await withBillingMatterAdvisoryLocks(
    tx,
    sql`
    SELECT DISTINCT hashtext(workspace_id) AS lock_key
    FROM unnest(ARRAY[${sql.join(
      workspaceIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]) AS matters(workspace_id)
  `,
  );
  return await tx
    .select({
      arrangement: getColumns(billingArrangements),
      ...usageProjection,
    })
    .from(billingArrangements)
    .where(
      and(
        inArray(billingArrangements.workspaceId, workspaceIds),
        eq(billingArrangements.mode, "hourly"),
        or(
          isNotNull(billingArrangements.capAmount),
          isNotNull(billingArrangements.capMinutes),
        ),
        isNotNull(billingArrangements.alertThresholdBps),
      ),
    )
    .orderBy(asc(billingArrangements.workspaceId))
    .limit(workspaceIds.length)
    .for("update");
};

export const lockBillingArrangement = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  // Same matter lock as timer/invoice guards; it also serializes first-row creation.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  const rows = await tx
    .select()
    .from(billingArrangements)
    .where(eq(billingArrangements.workspaceId, workspaceId))
    .limit(1)
    .for("update");
  return rows.at(0);
};

/** Timer guards use the same advisory key order before any matter row lock. */
export const withInvoiceMatterLocks = async (
  tx: Transaction,
  workspaceIds: readonly SafeId<"workspace">[],
) => {
  const ids = [...new Set(workspaceIds)].toSorted();
  if (ids.length === 0) {
    panic("Invoice matter locks require at least one matter");
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(keys.key) FROM (SELECT DISTINCT hashtext(matter_id::text) AS key FROM unnest(ARRAY[${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]) AS matter_id ORDER BY key) keys ORDER BY keys.key`,
  );
  await withAggregateParentBatch({
    tx,
    organizationIds: [],
    workspaceIds: ids,
    mode: "no key update",
  });
  for (const id of ids) {
    // db-await-in-loop: bounded invoice matter set, advisory locks already acquired together
    await lockBillingArrangement(tx, id);
  }
};

export type AcquiredInvoiceMatterLocks = {
  type: "acquired";
  invoiceId: SafeId<"invoice">;
  workspaceIds: ReadonlySet<SafeId<"workspace">>;
};
export type InvoiceMatterLocks =
  { type: "acquire" } | AcquiredInvoiceMatterLocks;

type LockInvoiceOptions = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  status: InvoiceStatus | readonly InvoiceStatus[];
  matterLocks: InvoiceMatterLocks;
};

/**
 * Locks the invoice row with `SELECT ... FOR UPDATE` and returns the columns
 * every mutation handler (update, transition, delete, add-entries,
 * remove-entries) needs to make its status-conditional decision. Callers
 * must re-check `status` (or the relevant precondition) inside the same
 * transaction before mutating, and repeat the identical status filter on the
 * mutating statement itself: the lock alone does not stop a concurrent
 * transaction from having already committed a status change before this one
 * started.
 *
 * Call this BEFORE any child-row writes (`time_entries`, `expenses`) inside
 * the transaction, never after. Every invoice mutation handler in this
 * module locks the invoice row first and mutates children second; a handler
 * that mutates children first and only touches the invoice row later (e.g.
 * via an `UPDATE invoices ...` at the end of the transaction) acquires its
 * locks in the opposite order and can deadlock against a concurrent
 * transaction that follows the invoice-first order.
 */
export const lockInvoiceInStatus = async (
  tx: Transaction,
  { invoiceId, workspaceId, status, matterLocks }: LockInvoiceOptions,
) => {
  const lineMattersRead = await readBounded(
    tx
      .selectDistinct({ workspaceId: invoiceLines.workspaceId })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId)),
    LIMITS.invoiceLinesPerInvoice,
  );
  if (lineMattersRead.type === "overflow") {
    return undefined;
  }
  const lineMatters = lineMattersRead.rows;
  const matterIds = [
    ...new Set([workspaceId, ...lineMatters.map((line) => line.workspaceId)]),
  ].toSorted();
  switch (matterLocks.type) {
    case "acquire":
      break;
    case "acquired":
      if (matterLocks.invoiceId !== invoiceId) {
        return panic("Invoice matter locks belong to another invoice");
      }
      if (matterIds.some((id) => !matterLocks.workspaceIds.has(id))) {
        return undefined;
      }
      break;
    default:
      matterLocks satisfies never;
      return panic("Unknown invoice matter lock scope");
  }
  await withInvoiceMatterLocks(tx, matterIds);
  const statusFilter =
    typeof status === "string"
      ? eq(invoices.status, status)
      : inArray(invoices.status, [...status]);

  const rows = await tx
    .select({
      id: invoices.id,
      status: invoices.status,
      documentType: invoices.documentType,
      billingMode: invoices.billingMode,
      flatFeeAmount: invoices.flatFeeAmount,
      originalInvoiceId: invoices.originalInvoiceId,
      finalizedAt: invoices.finalizedAt,
      currency: invoices.currency,
      language: invoices.language,
      vatAmount: invoices.vatAmount,
      dueDate: invoices.dueDate,
      invoiceDate: invoices.invoiceDate,
      invoiceNumber: invoices.invoiceNumber,
      notes: invoices.notes,
      reference: invoices.reference,
      sentAt: invoices.sentAt,
      sellerProfileId: invoices.sellerProfileId,
      taxableSupplyDate: invoices.taxableSupplyDate,
      totalAmount: invoices.totalAmount,
      vatExchangeRate: invoices.vatExchangeRate,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.id, invoiceId),
        invoiceInMatter(invoices, workspaceId),
        statusFilter,
      ),
    )
    .limit(1)
    .for("update");

  const invoice = rows.at(0);
  if (invoice === undefined) {
    return undefined;
  }
  // A concurrent writer can add a participating matter while this acquisition
  // waits. The invoice row now fences new participation; refuse a stale
  // lock set before callers mutate or acquire missing matter locks out of order.
  const currentMattersRead = await readBounded(
    tx
      .selectDistinct({ workspaceId: invoiceLines.workspaceId })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId)),
    LIMITS.invoiceLinesPerInvoice,
  );
  if (currentMattersRead.type === "overflow") {
    return undefined;
  }
  const currentMatters = currentMattersRead.rows;
  const lockedMatterIds = new Set(matterIds);
  if (currentMatters.some((line) => !lockedMatterIds.has(line.workspaceId))) {
    return undefined;
  }
  return invoice;
};

/** Caller holds the timer-owner and complete matter advisory set. */
export const lockBillingTimeEntrySources = async (
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select">,
  condition: SQL | undefined,
) =>
  await readBounded(
    {
      limit: (cap) =>
        tx
          .select({ id: timeEntries.id })
          .from(timeEntries)
          .where(condition)
          .orderBy(asc(timeEntries.id))
          .limit(cap)
          .for("update"),
    },
    LIMITS.timeEntriesPerWorkspace,
  );

/** Caller holds timer-owner locks; all selected matter advisory keys are acquired together. */
export const withBillingMatterAdvisoryLocks = async (
  tx: ExecuteTransaction,
  keys: SQL,
) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(matter_locks.lock_key) FROM (${keys} ORDER BY lock_key) matter_locks ORDER BY matter_locks.lock_key`,
  );
};

type LockOriginalInvoiceOptions = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
};
export const lockOriginalInvoice = async (
  tx: Transaction,
  { invoiceId, workspaceId }: LockOriginalInvoiceOptions,
) =>
  await tx
    .select({
      status: invoices.status,
      documentType: invoices.documentType,
      currency: invoices.currency,
      totalAmount: invoices.totalAmount,
    })
    .from(invoices)
    .where(
      and(eq(invoices.id, invoiceId), invoiceInMatter(invoices, workspaceId)),
    )
    .limit(1)
    .for("update");
type MemberAccessRowLockOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  mode: "share" | "no key update" | "update";
};

/** Lock the member within the caller's lifecycle or access-hold sequence. */
export const lockMemberAccessRow = async ({
  tx,
  organizationId,
  userId,
  mode,
}: MemberAccessRowLockOptions) =>
  (
    await tx
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
        ),
      )
      .limit(1)
      .for(mode)
  ).at(0);

/**
 * Holds off organization settings writes until the transaction ends: a first
 * settings row's foreign key needs a key-share lock on the organization row,
 * and a later write updates the settings row itself. A read after this lock
 * is the state every such write serializes with.
 */
export const lockOrganizationSettingsWrites = async ({
  tx,
  organizationIds,
}: {
  tx: Transaction;
  organizationIds: readonly SafeId<"organization">[];
}): Promise<void> => {
  if (organizationIds.length === 0) {
    return;
  }
  await withAggregateParentBatch({ tx, organizationIds, mode: "update" });
  await tx
    .select({ organizationId: organizationSettings.organizationId })
    .from(organizationSettings)
    .where(inArray(organizationSettings.organizationId, [...organizationIds]))
    .for("share");
};

type MatterAccessRowsLockOptions = MemberAccessRowLockOptions & {
  workspaceIds: readonly SafeId<"workspace">[];
  /** Narrows the locked rows; `and(...)` may yield undefined (no filter). */
  where?: SQL | undefined;
};

/** Lock assignments after the caller's member and optional matter prefix. */
export const lockMatterAccessAssignments = async ({
  tx,
  organizationId,
  userId,
  workspaceIds,
  mode,
  where,
}: MatterAccessRowsLockOptions) => {
  if (workspaceIds.length === 0) {
    return [];
  }
  return await tx
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        inArray(workspaceMembers.workspaceId, workspaceIds),
        eq(workspaces.organizationId, organizationId),
        where,
      ),
    )
    .orderBy(workspaceMembers.workspaceId, workspaceMembers.id)
    .limit(workspaceIds.length)
    .for(mode, { of: workspaceMembers });
};

type MatterAccessWorkspaceRowsLockOptions = Omit<
  MatterAccessRowsLockOptions,
  "userId"
>;

/**
 * Lock in stable matter order. A narrowing predicate can
 * select the unassigned matters whose reach depends on their row. Decide
 * access in a later statement, using only identities covered by held locks.
 */
export const lockMatterAccessWorkspaceRows = async ({
  tx,
  organizationId,
  workspaceIds,
  mode,
  where,
}: MatterAccessWorkspaceRowsLockOptions) => {
  if (workspaceIds.length === 0) {
    return [];
  }
  return await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        inArray(workspaces.id, workspaceIds),
        eq(workspaces.organizationId, organizationId),
        where,
      ),
    )
    .orderBy(workspaces.id)
    .limit(workspaceIds.length)
    .for(mode);
};

/** Shares the lifecycle fence used by matter deletion and timer writes. */
export const lockWorkspaceLifecycle = async (
  tx: ExecuteTransaction,
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
};

export const TIMER_MATTER_LOCK_SCOPE = {
  assignment: "assignment",
  client: "client",
} as const;

type TimerMatterAccessRowsLockOptions = Omit<
  MemberAccessRowLockOptions,
  "mode"
> & {
  workspaceId: SafeId<"workspace">;
  lockScope: SQL;
};

/**
 * Preserve the timer's joint matter/member SHARE statement. The supplied
 * scope only selects the original rows to lock; access is decided later.
 */
export const lockTimerMatterAccessRows = async ({
  tx,
  organizationId,
  userId,
  workspaceId,
  lockScope,
}: TimerMatterAccessRowsLockOptions) => {
  const rows = executedRows(
    await tx.execute(sql`
    SELECT ${lockScope} AS "lockScope"
    FROM workspaces AS workspace
    INNER JOIN member AS organization_member
      ON organization_member.organization_id = workspace.organization_id
      AND organization_member.user_id = ${userId}
    WHERE workspace.id = ${workspaceId}
      AND workspace.organization_id = ${organizationId}
      AND workspace.status = 'active'
      AND (${lockScope}) IS NOT NULL
    LIMIT 1
    FOR SHARE OF workspace, organization_member
  `),
  );
  const row = rows.at(0);
  if (row === undefined) {
    return null;
  }
  if (!isRecord(row)) {
    return panic("Invalid timer matter lock result");
  }
  const scope = row["lockScope"];
  switch (scope) {
    case TIMER_MATTER_LOCK_SCOPE.assignment:
    case TIMER_MATTER_LOCK_SCOPE.client:
      return scope;
    default:
      return panic("Invalid timer matter lock scope");
  }
};

/** Fence snapshot writers before removal discards their inputs. */
export const lockCaseLawRemovalSnapshots = async (
  tx: ExecuteTransaction,
): Promise<void> => {
  await tx.execute(sql`LOCK TABLE case_law_browse_facet_counts, case_law_coverage_summaries,
    case_law_sitemap_shard_counts, case_law_sitemap_shards, case_law_source_arrivals
    IN SHARE ROW EXCLUSIVE MODE`);
};

/** A coverage answer holds its snapshot fence before reading its inputs. */
export const lockCaseLawCoverageSnapshot = async (
  tx: ExecuteTransaction,
): Promise<void> => {
  await tx.execute(
    sql`LOCK TABLE case_law_coverage_summaries IN SHARE ROW EXCLUSIVE MODE`,
  );
};

/** Removal discovery and completion serialize their ledger and checkpoint on one source. */
export const lockCaseLawRemovalSource = async ({
  tx,
  sourceId,
}: {
  tx: ExecuteTransaction;
  sourceId: SafeId<"caseLawSource">;
}): Promise<void> => {
  await tx.execute(
    sql`SELECT id FROM case_law_sources WHERE id = ${sourceId} FOR UPDATE`,
  );
};

type LockBillingCodeOptions = {
  id: SafeId<"billingCode">;
  workspaceId: SafeId<"workspace">;
};

/** Fence new rate references before checking whether a code may be deleted. */
export const lockBillingCode = async (
  tx: Transaction,
  { id, workspaceId }: LockBillingCodeOptions,
) =>
  (
    await tx
      .select({
        id: billingCodes.id,
        type: billingCodes.type,
        code: billingCodes.code,
        label: billingCodes.label,
      })
      .from(billingCodes)
      .where(
        and(eq(billingCodes.id, id), eq(billingCodes.workspaceId, workspaceId)),
      )
      .limit(1)
      .for("update")
  ).at(0);

/** Caller holds the matter/timer guards before changing nonbillable work. */
export const lockUnbillableRateCandidates = async (
  tx: Transaction,
  condition: SQL | undefined,
) =>
  await tx
    .select({
      currency: timeEntries.currency,
      dateWorked: timeEntries.dateWorked,
      activityCode: timeEntries.activityCode,
      narrative: timeEntries.narrative,
      timezoneId: timeEntries.timezoneId,
      id: timeEntries.id,
      rateAtEntry: timeEntries.rateAtEntry,
      userId: timeEntries.userId,
    })
    .from(timeEntries)
    .where(condition)
    .for("update");
