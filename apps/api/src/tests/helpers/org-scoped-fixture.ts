import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { OrgScopeActor } from "@/api/db/org-scope";
import { proveOrgScope, withOrgScope } from "@/api/db/org-scope";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { AnyDrizzle } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type OrgScopedFixtureTransactionOptions<T> = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  actor?: Extract<OrgScopeActor, { type: "system" | "actor" }>;
  fn: (tx: Transaction) => Promise<T>;
};

/** Fixture writes borrow authority from a persisted matter in their transaction. */
export const withOrgScopedFixtureTransaction = async <T>({
  tx,
  workspaceId,
  actor = { type: "system" },
  fn,
}: OrgScopedFixtureTransactionOptions<T>): Promise<T> => {
  const scope = await proveOrgScope(tx, {
    table: "workspaces",
    where: eq(workspaces.id, workspaceId),
  });
  if (scope.isErr()) {
    panic("Scoped fixture matter must exist");
  }
  return await withOrgScope({
    tx,
    scope: scope.value,
    actor,
    fn,
  });
};

type OrgScopedFixtureOptions<T> = {
  database: AnyDrizzle;
  workspaceId: SafeId<"workspace">;
  actor?: Extract<OrgScopeActor, { type: "system" | "actor" }>;
  fn: (tx: Transaction) => Promise<T>;
};

/** Bun SQL and PGlite lend the same role/settings contract to fixture callbacks. */
export const withOrgScopedFixture = async <T>({
  database,
  workspaceId,
  actor = { type: "system" },
  fn,
}: OrgScopedFixtureOptions<T>): Promise<T> =>
  await database.transaction(
    async (tx) =>
      await withOrgScopedFixtureTransaction({
        tx: asTestRaw<Transaction>(tx),
        workspaceId,
        actor,
        fn,
      }),
  );
