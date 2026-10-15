import { Result, TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { stellaAuthorizedWorkspaces } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * The one owner of "which matters may this actor read" outside the row
 * policies themselves: the request and MCP workspace sets that search, chat,
 * MCP tools and playbooks filter by, and the inline checks that compare a
 * stored workspace id with the actor's access.
 *
 * Every function here reads `stella_authorized_workspaces`, the view the
 * workspace row policies consult, inside the caller's scoped transaction.
 * Whatever that view admits or screens out therefore applies to these paths
 * too, without a second definition of access. The matter-access census in
 * `apps/api/src/tests/security/matter-access-census.test.ts` keeps other
 * modules from reading the view or re-deriving its rule themselves.
 */

type AuthorizedWorkspaceReader = Pick<Transaction, "select" | "selectDistinct">;

export type AuthorizedWorkspaceSet = {
  /** Every authorized workspace with its status, including `deleting`. */
  readonly workspaces: AccessibleWorkspace[];
  /** Authorized workspaces that are not being deleted. */
  readonly activeIds: SafeId<"workspace">[];
};

export class AuthorizedWorkspaceReadError extends TaggedError(
  "AuthorizedWorkspaceReadError",
)<{
  message: string;
  cause: unknown;
}> {}

const readFailure = (cause: unknown) =>
  new AuthorizedWorkspaceReadError({
    message: "Failed to read authorized workspaces",
    cause,
  });

type OrganizationScope = {
  organizationId: SafeId<"organization">;
};

/**
 * Read the actor's authorized workspaces in its scoped transaction. The
 * organization predicate keeps the read on the tenant index and bounds the
 * explicit ids the transaction carries to the organization.
 */
export const readAuthorizedWorkspaces = async (
  tx: AuthorizedWorkspaceReader,
  { organizationId }: OrganizationScope,
): Promise<Result<AuthorizedWorkspaceSet, AuthorizedWorkspaceReadError>> =>
  (
    await Result.tryPromise({
      try: async () =>
        await tx
          .selectDistinct({ id: workspaces.id, status: workspaces.status })
          .from(stellaAuthorizedWorkspaces)
          .innerJoin(
            workspaces,
            eq(workspaces.id, stellaAuthorizedWorkspaces.authorizedWorkspaceId),
          )
          .where(eq(workspaces.organizationId, organizationId)),
      catch: readFailure,
    })
  ).map((rows) => ({
    workspaces: rows,
    activeIds: rows
      .filter((row) => row.status !== "deleting")
      .map((row) => row.id),
  }));

/** The active authorized workspace ids, for callers that need only the ids. */
export const authorizedWorkspaceIds = async (
  tx: AuthorizedWorkspaceReader,
  scope: OrganizationScope,
): Promise<Result<SafeId<"workspace">[], AuthorizedWorkspaceReadError>> =>
  (await readAuthorizedWorkspaces(tx, scope)).map((set) => set.activeIds);

/**
 * The statement that finds one active workspace in the transaction's
 * authorized set (at most one row). The caller's transaction settings decide
 * whose access this is. Exposed as a statement so a caller that must keep
 * its own row locks and failure handling can run it in place.
 */
export const activeAuthorizedWorkspaceQuery = (
  tx: Pick<Transaction, "select">,
  workspaceId: SafeId<"workspace">,
) =>
  tx
    .select({ id: stellaAuthorizedWorkspaces.authorizedWorkspaceId })
    .from(stellaAuthorizedWorkspaces)
    .where(
      and(
        eq(stellaAuthorizedWorkspaces.authorizedWorkspaceId, workspaceId),
        eq(stellaAuthorizedWorkspaces.workspaceStatus, "active"),
      ),
    )
    .limit(1);

/**
 * The authorized workspace ids as a subquery, for a statement that must
 * compare stored workspace ids with the reader's access in the same query.
 */
export const authorizedWorkspaceIdSubquery = (): SQL =>
  sql`SELECT aw.authorized_workspace_id FROM ${stellaAuthorizedWorkspaces} aw`;
