import { Result, TaggedError } from "better-result";
import type { SQL } from "drizzle-orm";

import { ORG_SCOPE_TABLES } from "@/api/db/org-scope-registry";
import type { Transaction } from "@/api/db/root";
import { runScopedOwnerWorkInTransaction } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { lockOrgScopeSource } from "@/api/lib/db/aggregate-lock";

const ORG_SCOPE: unique symbol = Symbol("stella.orgScope");

export type OrgScope = {
  readonly [ORG_SCOPE]: true;
  readonly organizationId: SafeId<"organization">;
  readonly workspaceIds: readonly SafeId<"workspace">[];
  readonly provenFrom: {
    readonly table: keyof typeof ORG_SCOPE_TABLES;
    readonly id: string;
  };
};

export class OrgScopeRowAbsent extends TaggedError("OrgScopeRowAbsent")<{
  message: string;
  table: keyof typeof ORG_SCOPE_TABLES;
}> {}

export class OrgScopeMismatch extends TaggedError("OrgScopeMismatch")<{
  message: string;
}> {}

type OrgScopeReference = { table: keyof typeof ORG_SCOPE_TABLES; where: SQL };

/** Lock row-derived authority; missing sources are typed absence, while query failures propagate. */
export const proveOrgScope = async (
  tx: Pick<Transaction, "select" | "execute">,
  ref: OrgScopeReference,
): Promise<Result<OrgScope, OrgScopeRowAbsent>> => {
  const row = await lockOrgScopeSource({
    tx,
    source: ORG_SCOPE_TABLES[ref.table],
    where: ref.where,
  });
  if (row === undefined) {
    return Result.err(
      new OrgScopeRowAbsent({
        message: "Scope source is absent",
        table: ref.table,
      }),
    );
  }
  return Result.ok({
    [ORG_SCOPE]: true as const,
    organizationId: row.organizationId,
    workspaceIds: row.workspaceId === null ? [] : [row.workspaceId],
    provenFrom: { table: ref.table, id: row.id },
  });
};

export const assertCallerOrg = (
  scope: OrgScope,
  organizationId: SafeId<"organization">,
): Result<void, OrgScopeMismatch> =>
  scope.organizationId === organizationId
    ? Result.ok(undefined)
    : Result.err(
        new OrgScopeMismatch({
          message: "Scope organization does not match the operation",
        }),
      );

/** Combine only locked source proofs belonging to the same organization. */
export const combineOrgScopes = (
  first: OrgScope,
  second: OrgScope,
): Result<OrgScope, OrgScopeMismatch> => {
  const agreement = assertCallerOrg(first, second.organizationId);
  if (Result.isError(agreement)) {
    return agreement;
  }
  return Result.ok({
    [ORG_SCOPE]: true as const,
    organizationId: first.organizationId,
    workspaceIds: [...new Set([...first.workspaceIds, ...second.workspaceIds])],
    provenFrom: first.provenFrom,
  });
};

export type OrgScopeActor =
  | { type: "system" }
  | { type: "actor"; userId: SafeId<"user"> };

type WithOrgScopeOptions<T> = {
  tx: Transaction;
  scope: OrgScope;
  actor: OrgScopeActor;
  fn: (tx: Transaction) => Promise<T>;
};

export const withOrgScope = async <T>({
  tx,
  scope,
  actor,
  fn,
}: WithOrgScopeOptions<T>): Promise<T> =>
  await runScopedOwnerWorkInTransaction({ tx, scope, actor, fn });
