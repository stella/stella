import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  workspaces,
  entities,
  flowRuns,
  flowRunSteps,
  workObligations,
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
    tx: { execute: (statement: SQL) => PromiseLike<unknown> };
  };
}[AggregateName];

type AggregateLockResult = { status: "locked" } | { status: "missing" };

type HeldLock = { rank: number; key: string };
type LockHistory =
  | { status: "idle"; held: Map<string, HeldLock> }
  | { status: "acquiring"; held: Map<string, HeldLock> };

// The transaction, rather than a helper callback, owns every acquired lock.
const histories = new WeakMap<object, LockHistory>();

const lockIdentity = (options: AggregateLockOptions): string => {
  switch (options.aggregate) {
    case "organization":
      return JSON.stringify([options.aggregate, options.id]);
    case "workspace":
    case "run":
    case "currentStep":
    case "obligation":
    case "entity":
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

const lockStatement = (options: AggregateLockOptions) => {
  switch (options.aggregate) {
    case "organization":
      return sql`SELECT ${organization.id} FROM ${organization} WHERE ${organization.id} = ${options.id} FOR UPDATE`;
    case "workspace":
      return sql`SELECT ${workspaces.id} FROM ${workspaces} WHERE ${workspaces.id} = ${options.id.id} AND ${workspaces.organizationId} = ${options.id.organizationId} FOR UPDATE`;
    case "run":
      return sql`SELECT ${flowRuns.id} FROM ${flowRuns} WHERE ${flowRuns.id} = ${options.id.id} AND ${flowRuns.workspaceId} = ${options.id.workspaceId} FOR UPDATE`;
    case "currentStep":
      return sql`SELECT ${flowRunSteps.id} FROM ${flowRunSteps} WHERE ${flowRunSteps.id} = ${options.id.id} AND ${flowRunSteps.workspaceId} = ${options.id.workspaceId} FOR UPDATE`;
    case "obligation":
      return sql`SELECT ${workObligations.entityId} FROM ${workObligations} WHERE ${workObligations.entityId} = ${options.id.id} AND ${workObligations.workspaceId} = ${options.id.workspaceId} FOR UPDATE`;
    case "entity":
      return sql`SELECT ${entities.id} FROM ${entities} WHERE ${entities.id} = ${options.id.id} AND ${entities.workspaceId} = ${options.id.workspaceId} FOR UPDATE`;
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
  const history = histories.get(tx) ?? {
    status: "idle",
    held: new Map<string, HeldLock>(),
  };
  if (history.status === "acquiring") {
    return panic(
      "Await each aggregate lock acquisition before starting another",
    );
  }
  const { rank, kind } = AGGREGATE_LOCKS[aggregate];
  for (const held of history.held.values()) {
    if (
      !history.held.has(key) &&
      (rank < held.rank || (rank === held.rank && key < held.key))
    ) {
      return panic("Aggregate lock rank inversion");
    }
  }
  histories.set(tx, { status: "acquiring", held: history.held });
  // A failed SQL acquisition aborts the transaction. Retaining its reservation
  // refuses accidental reuse; a retry owns a fresh transaction and history.
  const result = await tx.execute(lockStatement(options));
  const acquired = kind === "advisory" || executedRows(result).length > 0;
  if (acquired) {
    history.held.set(key, { rank, key });
  }
  histories.set(tx, { status: "idle", held: history.held });
  return acquired ? { status: "locked" } : { status: "missing" };
};
