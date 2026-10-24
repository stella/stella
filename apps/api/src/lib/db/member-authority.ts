import { Result } from "better-result";
import { and, eq, exists, inArray, isNotNull, or } from "drizzle-orm";

import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import { lockMemberAccessRow } from "@/api/lib/db/aggregate-lock";
import { holdMemberAccessOnTx } from "@/api/lib/db/member-access-hold";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasCurrentMemberPermission } from "@/api/lib/permission-authorization";

/** Structural subset accepted by production transactions and PGlite tests. */
type WorkspaceMemberAuthorityDb = Pick<Transaction, "select">;

type WorkspaceMemberLookup = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const workspaceMemberAccessCondition = (
  db: WorkspaceMemberAuthorityDb,
) => {
  const membershipExists = exists(
    db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, member.userId),
        ),
      ),
  );
  // sql-perf-allow: bounded by one target workspace and organization membership keys
  return or(
    membershipExists,
    and(
      inArray(member.role, CLIENT_MATTER_ADMIN_ROLES),
      isNotNull(workspaces.clientId),
    ),
  );
};

/** Resolve a person's current organization role and matter access. */
export const resolveWorkspaceMemberAuthority = async (
  { organizationId, userId, workspaceId }: WorkspaceMemberLookup,
  db: WorkspaceMemberAuthorityDb,
): Promise<{ role: string; workspace: AccessibleWorkspace } | null> => {
  const row = await db
    .select({
      role: member.role,
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status,
    })
    .from(member)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, member.organizationId),
        workspaceMemberAccessCondition(db),
      ),
    )
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
    )
    .limit(1)
    .then((rows) => rows.at(0));
  return row
    ? {
        role: row.role,
        workspace: { id: row.workspaceId, status: row.workspaceStatus },
      }
    : null;
};

export const resolveWorkspaceMemberAccess = async (
  lookup: WorkspaceMemberLookup,
  db: WorkspaceMemberAuthorityDb,
): Promise<AccessibleWorkspace | null> =>
  (await resolveWorkspaceMemberAuthority(lookup, db))?.workspace ?? null;

type CurrentWorkspaceMemberPermissionOptions = WorkspaceMemberLookup & {
  db: Transaction;
  permissions: PermissionInput;
};

/**
 * Recheck the authority a deferred member action needs now. Archived and
 * deleting matters cannot receive new model work or output publications.
 */
export const hasCurrentActiveWorkspaceMemberPermission = async ({
  db,
  permissions,
  ...lookup
}: CurrentWorkspaceMemberPermissionOptions): Promise<boolean> => {
  const held = await holdMemberAccessOnTx(db, {
    organizationId: lookup.organizationId,
    userId: lookup.userId,
    workspaceIds: [lookup.workspaceId],
  });
  if (
    held.type === "not-member" ||
    held.workspaceIds.at(0) !== lookup.workspaceId
  ) {
    return false;
  }
  const workspace = (
    await db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, lookup.workspaceId),
          eq(workspaces.organizationId, lookup.organizationId),
        ),
      )
      .limit(1)
  ).at(0);
  const authority = await resolveWorkspaceMemberAuthority(lookup, db);
  return (
    authority !== null &&
    workspace?.status === "active" &&
    isMemberRole(authority.role) &&
    hasCurrentMemberPermission(authority.role, permissions)
  );
};

type CurrentOrganizationMemberPermissionOptions = {
  db: Transaction;
  organizationId: SafeId<"organization">;
  permissions: PermissionInput;
  userId: SafeId<"user">;
};

/** Hold and recheck organization authority for the rest of the transaction. */
const hasCurrentOrganizationMemberPermission = async ({
  db,
  organizationId,
  permissions,
  userId,
}: CurrentOrganizationMemberPermissionOptions): Promise<boolean> => {
  const organizationMember = await lockMemberAccessRow({
    tx: db,
    organizationId,
    userId,
    mode: "share",
  });
  return (
    organizationMember !== undefined &&
    isMemberRole(organizationMember.role) &&
    hasCurrentMemberPermission(organizationMember.role, permissions)
  );
};

export const requireCurrentOrganizationMemberPermission = async (
  options: CurrentOrganizationMemberPermissionOptions,
): Promise<void> => {
  const authorization = (await hasCurrentOrganizationMemberPermission(options))
    ? Result.ok(undefined)
    : Result.err(
        new HandlerError({
          status: 403,
          message: "Organization administrator access required",
        }),
      );
  if (authorization.isOk()) {
    return;
  }
  abortTransaction(authorization.error);
};
