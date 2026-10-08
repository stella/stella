import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { rootDb, Transaction } from "@/api/db/root";
import {
  workspaces,
  entities,
  flowRuns,
  flowRunSteps,
  workObligations,
  signals,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";

/** Ranks order physical fences; catalog names sharing a key share one entry. */
export const AGGREGATE_LOCKS = {
  organization: { rank: 0, kind: "row" },
  workspace: { rank: 100, kind: "row" },
  run: { rank: 200, kind: "row" },
  currentStep: { rank: 300, kind: "row" },
  obligation: { rank: 400, kind: "row" },
  entity: { rank: 500, kind: "row" },
  signal: { rank: 600, kind: "row" },
  automatedFlowRunCap: { rank: 700, kind: "advisory" },
  contactCapacity: { rank: 700, kind: "advisory" },
  personalCatalog: { rank: 700, kind: "advisory" },
} as const;

export type AggregateName = keyof typeof AGGREGATE_LOCKS;

type AggregateIdentities = {
  organization: SafeId<"organization">;
  workspace: {
    id: SafeId<"workspace">;
    organizationId: SafeId<"organization">;
  };
  run: { id: SafeId<"flowRun">; workspaceId: SafeId<"workspace"> };
  currentStep: { id: SafeId<"flowRunStep">; workspaceId: SafeId<"workspace"> };
  obligation: { id: SafeId<"entity">; workspaceId: SafeId<"workspace"> };
  entity: { id: SafeId<"entity">; workspaceId: SafeId<"workspace"> };
  signal: { id: SafeId<"signal">; organizationId: SafeId<"organization"> };
  automatedFlowRunCap: SafeId<"flowDefinition">;
  contactCapacity: { organizationId: SafeId<"organization"> };
  personalCatalog: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
};

type AggregateLockOptions = {
  [Name in AggregateName]: {
    aggregate: Name;
    id: AggregateIdentities[Name];
    mode?: Name extends "workspace" ? "share" | "update" : never;
    tx: { execute: (statement: SQL) => PromiseLike<unknown> };
  };
}[AggregateName];

type AggregateLockResult = { status: "locked" } | { status: "missing" };

type HeldLock = { rank: number; key: string };
type LockHistory = {
  status: "idle" | "acquiring" | "closed";
  held: Map<string, HeldLock>;
  parent: LockHistory | undefined;
  children: Set<LockHistory>;
};

// Each level records only locks acquired there; ancestors retain their locks
// until the physical transaction ends, including across savepoint rollback.
const histories = new WeakMap<object, LockHistory>();
const lockHistory = (tx: object): LockHistory => {
  const existing = histories.get(tx);
  if (existing !== undefined) {
    return existing;
  }
  const history: LockHistory = {
    status: "idle",
    held: new Map(),
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
    if (level.held.size > 0 || level.status === "acquiring") {
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
const assertLockOrder = (history: LockHistory, lock: HeldLock): void => {
  const held: HeldLock[] = [];
  for (
    let level: LockHistory | undefined = history;
    level !== undefined;
    level = level.parent
  ) {
    held.push(...level.held.values());
  }
  if (held.some((previous) => previous.key === lock.key)) {
    return;
  }
  if (
    held.some(
      (previous) =>
        lock.rank < previous.rank ||
        (lock.rank === previous.rank && lock.key < previous.key),
    )
  ) {
    panic("Aggregate lock rank inversion");
  }
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
    held: new Map(),
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
        return { value, held: history.held };
      } finally {
        history.status = "closed";
      }
    });
    for (const [key, lock] of committed.held) {
      parent.held.set(key, lock);
    }
    return committed.value;
  } finally {
    history.status = "closed";
    parent.children.delete(history);
  }
};

const lockIdentity = (options: AggregateLockOptions): string => {
  switch (options.aggregate) {
    case "automatedFlowRunCap":
    case "organization":
      return JSON.stringify([options.aggregate, options.id]);
    case "workspace":
    case "run":
    case "currentStep":
    case "obligation":
    case "entity":
    case "signal":
      return JSON.stringify([options.aggregate, options.id.id]);
    case "contactCapacity":
      return JSON.stringify([options.aggregate, options.id.organizationId]);
    case "personalCatalog":
      return JSON.stringify([
        options.aggregate,
        options.id.organizationId,
        options.id.userId,
      ]);
    default:
      options satisfies never;
      return panic("Unknown aggregate lock identity");
  }
};

// Keep the legacy per-definition advisory key shared by every automated starter.
const FLOW_RUN_CAP_LOCK_NAMESPACE = 0x0f_10_cc_a9;

const lockStatement = (options: AggregateLockOptions) => {
  switch (options.aggregate) {
    case "organization":
      return sql`SELECT ${organization.id} FROM ${organization} WHERE ${organization.id} = ${options.id} FOR UPDATE`;
    case "workspace": {
      const mode = options.mode === "share" ? sql`FOR SHARE` : sql`FOR UPDATE`;
      return sql`SELECT ${workspaces.id} FROM ${workspaces} WHERE ${workspaces.id} = ${options.id.id} AND ${workspaces.organizationId} = ${options.id.organizationId} ${mode}`;
    }
    case "run":
      return sql`SELECT ${flowRuns.id} FROM ${flowRuns} WHERE ${flowRuns.id} = ${options.id.id} AND ${flowRuns.workspaceId} = ${options.id.workspaceId} FOR UPDATE`;
    case "currentStep":
      return sql`SELECT ${flowRunSteps.id} FROM ${flowRunSteps} WHERE ${flowRunSteps.id} = ${options.id.id} AND ${flowRunSteps.workspaceId} = ${options.id.workspaceId} FOR UPDATE`;
    case "obligation":
      return sql`SELECT ${workObligations.entityId} FROM ${workObligations} WHERE ${workObligations.entityId} = ${options.id.id} AND ${workObligations.workspaceId} = ${options.id.workspaceId} FOR UPDATE`;
    case "entity":
      return sql`SELECT ${entities.id} FROM ${entities} WHERE ${entities.id} = ${options.id.id} AND ${entities.workspaceId} = ${options.id.workspaceId} FOR UPDATE`;
    case "signal":
      return sql`SELECT ${signals.id} FROM ${signals} WHERE ${signals.id} = ${options.id.id} AND ${signals.organizationId} = ${options.id.organizationId} FOR UPDATE`;
    case "automatedFlowRunCap":
      return sql`SELECT pg_advisory_xact_lock(${FLOW_RUN_CAP_LOCK_NAMESPACE}, hashtext(${options.id}))`;
    case "contactCapacity":
      return sql`SELECT pg_advisory_xact_lock(hashtext('contact_capacity'), hashtext(${options.id.organizationId}))`;
    case "personalCatalog":
      return sql`SELECT pg_advisory_xact_lock(hashtext(${options.id.organizationId}), hashtext(${options.id.userId}))`;
    default:
      options satisfies never;
      return panic("Unknown aggregate lock statement");
  }
};

/** Joins the caller's transaction; reads and decisions follow the awaited fence. */
export const withAggregateLock = async (
  options: AggregateLockOptions,
): Promise<AggregateLockResult> => {
  const { tx, aggregate } = options;
  const key = lockIdentity(options);
  const history = lockHistory(tx);
  assertAggregateLevelAvailable(history);
  const { rank, kind } = AGGREGATE_LOCKS[aggregate];
  assertLockOrder(history, { rank, key });
  history.status = "acquiring";
  // A failed SQL acquisition aborts the transaction. Retaining its reservation
  // refuses accidental reuse; a retry owns a fresh transaction and history.
  const result = await tx.execute(lockStatement(options));
  const acquired = kind === "advisory" || executedRows(result).length > 0;
  if (acquired) {
    history.held.set(key, { rank, key });
  }
  completeAcquisition(history);
  return acquired ? { status: "locked" } : { status: "missing" };
};

type AutomatedFlowRunCapLockOptions = {
  definitionId: SafeId<"flowDefinition">;
  database: Pick<typeof rootDb, "transaction">;
};

/** Own the cap transaction so the decision and insert share its advisory fence. */
export const withAutomatedFlowRunCapLock = async <T>(
  { definitionId, database }: AutomatedFlowRunCapLockOptions,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await database.transaction(async (tx) => {
    await withAggregateLock({
      aggregate: "automatedFlowRunCap",
      id: definitionId,
      tx,
    });
    return await run(tx);
  });
