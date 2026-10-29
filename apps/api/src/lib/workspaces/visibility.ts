import { panic } from "better-result";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

import {
  MATTER_STEWARD_HANDOVER_MAX_MATTERS,
  MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
  MATTER_VISIBILITY,
} from "@stll/api-contract";
import type { MatterVisibility } from "@stll/api-contract";
import type { PermissionInput } from "@stll/permissions";
import {
  INTERNAL_MEMBER_ROLES,
  ORGANIZATION_MATTER_ADMIN_ROLES,
} from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMatterAccessWorkspaceRows,
  lockMatterStewardship,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasCurrentMemberPermission } from "@/api/lib/permission-authorization";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";

/** The visibilities owners and admins reach without an assignment. */
const ADMIN_REACHABLE_VISIBILITIES = [
  MATTER_VISIBILITY.adminsAndAssigned,
  MATTER_VISIBILITY.allMembers,
] as const satisfies readonly MatterVisibility[];

/**
 * SQL predicate: a member holding the role in `role` reaches the joined
 * `workspaces` row without an assignment. Mirrors the last branch of the
 * stella_authorized_workspaces view: owners and admins reach
 * `admins_and_assigned` and `all_members` matters, every internal member
 * reaches `all_members` matters, and nobody reaches an `assigned_only` matter
 * this way. A raw query over an aliased matter passes its own `visibility`
 * expression; every SQL statement of the rule is built here.
 */
export const reachesMatterWithoutAssignmentSql = (
  role: SQLWrapper,
  visibility: SQLWrapper = workspaces.visibility,
): SQL | undefined =>
  or(
    and(
      inArray(role, ORGANIZATION_MATTER_ADMIN_ROLES),
      inArray(visibility, ADMIN_REACHABLE_VISIBILITIES),
    ),
    and(
      inArray(role, INTERNAL_MEMBER_ROLES),
      eq(visibility, MATTER_VISIBILITY.allMembers),
    ),
  );

/**
 * Does this organization role reach a matter of this visibility without an
 * assignment? The TypeScript twin of {@link reachesMatterWithoutAssignmentSql}.
 */
export const reachesMatterWithoutMembership = ({
  role,
  visibility,
}: {
  role: string;
  visibility: MatterVisibility;
}): boolean => {
  switch (visibility) {
    case MATTER_VISIBILITY.allMembers:
      return INTERNAL_MEMBER_ROLES.some((internal) => internal === role);
    case MATTER_VISIBILITY.adminsAndAssigned:
      return ORGANIZATION_MATTER_ADMIN_ROLES.some((admin) => admin === role);
    case MATTER_VISIBILITY.assignedOnly:
      return false;
    default:
      visibility satisfies never;
      return panic(`Unhandled matter visibility: ${String(visibility)}`);
  }
};

type MatterMutationAuthorityOptions = {
  permissions: PermissionInput;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
};

/**
 * Read current reach and authority after the caller acquires the complete
 * stewardship prefix. A matter pinned by earlier authorization can have been
 * narrowed while the writer waited; that pin does not establish current reach.
 */
export const readMatterMutationAuthority = async (
  tx: Transaction,
  {
    organizationId,
    workspaceId,
    userId,
    permissions,
  }: MatterMutationAuthorityOptions,
): Promise<{ managesOrganizationMatters: boolean } | null> => {
  const rows = await tx
    .select({ role: member.role })
    .from(workspaces)
    .innerJoin(
      member,
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
        ne(workspaces.status, "deleting"),
        memberReachesMatterSql({ organizationId, userId }, workspaces.id),
      ),
    )
    .limit(1);
  const membership = rows.at(0);
  if (
    !membership ||
    !isMemberRole(membership.role) ||
    !hasCurrentMemberPermission(membership.role, permissions)
  ) {
    return null;
  }
  return {
    managesOrganizationMatters: ORGANIZATION_MATTER_ADMIN_ROLES.some(
      (role) => role === membership.role,
    ),
  };
};

export const matterVisibilitySchema = (options?: { description?: string }) => {
  const schema = v.picklist([
    MATTER_VISIBILITY.allMembers,
    MATTER_VISIBILITY.adminsAndAssigned,
    MATTER_VISIBILITY.assignedOnly,
  ]);
  return options?.description
    ? v.pipe(schema, v.description(options.description))
    : schema;
};

/**
 * The steward invariant: an assigned-only matter is reached only by its
 * assignments and managed by its lead, so it always has a usable lead, one
 * who is an internal member of the matter's organization and assigned to it.
 * Every path that sets or narrows visibility, changes the lead, or removes a
 * lead's assignment or membership keeps it through this module.
 */
export const hasUsableSteward = async (
  tx: Transaction,
  {
    organizationId,
    workspaceId,
    leadUserId,
    assigningUserIds = [],
  }: {
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace">;
    leadUserId: string | null;
    /** Members assigned in the same change, not yet written. */
    assigningUserIds?: readonly string[];
  },
): Promise<boolean> => {
  if (leadUserId === null) {
    return false;
  }
  await lockMatterStewardship({
    tx,
    requests: [
      {
        organizationId,
        workspaceIds: [workspaceId],
        userIds: [leadUserId, ...assigningUserIds],
      },
    ],
    mode: "update",
  });
  const internal = await tx
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, leadUserId),
        inArray(member.role, INTERNAL_MEMBER_ROLES),
      ),
    )
    .limit(1);
  if (internal.length === 0) {
    return false;
  }
  if (assigningUserIds.includes(leadUserId)) {
    return true;
  }
  const assigned = await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, leadUserId),
      ),
    )
    .limit(1);
  return assigned.length > 0;
};

const internalRoles = sql.join(
  INTERNAL_MEMBER_ROLES.map((role) => sql`${role}`),
  sql`, `,
);

const restoredSteward = v.object({
  id: v.string(),
  lead_user_id: v.nullable(v.string()),
  old_lead_user_id: v.nullable(v.string()),
});

/**
 * Hand over assigned-only matters before a lead's assignment or membership
 * leaves. With no other internal assignee, refuse removal until handover.
 * Visibility never widens automatically. The departing user is never
 * chosen. Locks serialize the candidate read with membership/assignment loss.
 */
export const restoreMatterStewards = async (
  tx: Transaction,
  {
    organizationId,
    workspaceIds,
    departingUserId,
    actorUserId,
    recordAuditEvent,
  }: {
    organizationId: SafeId<"organization">;
    workspaceIds: readonly SafeId<"workspace">[];
    departingUserId: string;
    actorUserId: SafeId<"user">;
    recordAuditEvent: AuditRecorder;
  },
): Promise<void> => {
  if (workspaceIds.length === 0) {
    return;
  }
  const requested = [...new Set(workspaceIds)];
  await lockMatterStewardship({
    tx,
    requests: [
      {
        organizationId,
        workspaceIds: requested,
        userIds: [departingUserId, actorUserId],
      },
    ],
    mode: "update",
  });
  const locked = await lockMatterAccessWorkspaceRows({
    tx,
    organizationId,
    workspaceIds: requested,
    mode: "update",
  });
  if (locked.length !== requested.length) {
    panic("Cannot repair a missing or out-of-organization matter");
  }
  const ids = sql.join(
    requested.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const blocked = executedRows(
    await tx.execute(sql`
    SELECT w.id, w.name, EXISTS (
      SELECT 1 FROM workspace_members actor_assignment
      WHERE actor_assignment.workspace_id = w.id AND actor_assignment.user_id = ${actorUserId}
    ) AS actor_reaches
    FROM workspaces w
    WHERE w.id IN (${ids}) AND w.organization_id = ${organizationId}
      AND w.visibility = ${MATTER_VISIBILITY.assignedOnly}
      AND NOT EXISTS (
        SELECT 1 FROM workspace_members wm
        JOIN member m ON m.user_id = wm.user_id AND m.organization_id = w.organization_id
        WHERE wm.workspace_id = w.id AND wm.user_id <> ${departingUserId}
          AND m.role IN (${internalRoles})
      )
    ORDER BY w.id
  `),
  ).map((row) =>
    v.parse(
      v.object({
        id: v.string(),
        name: v.string(),
        actor_reaches: v.boolean(),
      }),
      row,
    ),
  );
  if (blocked.length > 0) {
    abortTransaction(
      new HandlerError({
        status: 409,
        code: MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
        message:
          "Hand over these matters to an assigned internal member before removing their steward.",
        affectedMatters: blocked
          .filter((row) => row.actor_reaches)
          .slice(0, MATTER_STEWARD_HANDOVER_MAX_MATTERS)
          .map(({ id, name }) => ({ id: brandPersistedWorkspaceId(id), name })),
      }),
    );
  }
  const repaired = executedRows(
    await tx.execute(sql`
      WITH broken AS (
        SELECT w.id, w.organization_id, w.lead_user_id AS old_lead_user_id
        FROM workspaces AS w
        WHERE w.id IN (${ids})
          AND w.organization_id = ${organizationId}
          AND w.visibility = ${MATTER_VISIBILITY.assignedOnly}
          AND NOT EXISTS (
            SELECT 1
            FROM workspace_members AS wm
            JOIN member AS m
              ON m.user_id = wm.user_id
             AND m.organization_id = w.organization_id
            WHERE wm.workspace_id = w.id
              AND wm.user_id = w.lead_user_id
              AND wm.user_id <> ${departingUserId}
              AND m.role IN (${internalRoles})
          )
      ),
      steward AS (
        SELECT DISTINCT ON (wm.workspace_id) wm.workspace_id, wm.user_id
        FROM workspace_members AS wm
        JOIN broken AS b ON b.id = wm.workspace_id
        JOIN member AS m
          ON m.user_id = wm.user_id
         AND m.organization_id = b.organization_id
        WHERE wm.user_id <> ${departingUserId}
          AND m.role IN (${internalRoles})
        ORDER BY wm.workspace_id, wm.created_at, wm.id
      )
      UPDATE workspaces AS w
      SET
        lead_user_id = steward.user_id
      FROM broken
      JOIN steward ON steward.workspace_id = broken.id
      WHERE w.id = broken.id
      RETURNING w.id, w.lead_user_id, broken.old_lead_user_id
    `),
  ).map((row) => v.parse(restoredSteward, row));
  if (repaired.length === 0) {
    return;
  }
  await recordAuditEvent(
    tx,
    repaired.map(
      ({ id, lead_user_id: leadUserId, old_lead_user_id: oldLeadUserId }) => ({
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
        resourceId: id,
        workspaceId: brandPersistedWorkspaceId(id),
        changes: {
          leadUserId: { old: oldLeadUserId, new: leadUserId },
        },
        metadata: {
          cause: "matter_steward_restored",
        },
      }),
    ),
  );
};

type RecoverOrphanedMatterStewardOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  stewardUserId: SafeId<"user">;
  actorUserId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
};

/** Recovery hands an orphaned matter to another member without widening visibility. */
export const recoverOrphanedMatterSteward = async (
  tx: Transaction,
  {
    organizationId,
    workspaceId,
    stewardUserId,
    actorUserId,
    recordAuditEvent,
  }: RecoverOrphanedMatterStewardOptions,
): Promise<void> => {
  // Recovery cannot grant matter read access to its acting administrator.
  if (stewardUserId === actorUserId) {
    abortTransaction(
      new HandlerError({ status: 404, message: "Matter not found" }),
    );
  }
  await lockMatterStewardship({
    tx,
    requests: [
      {
        organizationId,
        workspaceIds: [workspaceId],
        userIds: [actorUserId, stewardUserId],
      },
    ],
    mode: "update",
  });
  const memberships = await tx
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.userId, [actorUserId, stewardUserId]),
      ),
    );
  const actor = memberships.find((row) => row.userId === actorUserId);
  if (
    !actor ||
    !ORGANIZATION_MATTER_ADMIN_ROLES.some((role) => role === actor.role)
  ) {
    abortTransaction(
      new HandlerError({
        status: 403,
        message: "Organization matter management permission required",
      }),
    );
  }
  const steward = memberships.find((row) => row.userId === stewardUserId);
  if (
    !steward ||
    !INTERNAL_MEMBER_ROLES.some((role) => role === steward.role)
  ) {
    abortTransaction(
      new HandlerError({
        status: 400,
        message: "Name an internal member of this organization as steward",
      }),
    );
  }
  const locked = await lockMatterAccessWorkspaceRows({
    tx,
    organizationId,
    workspaceIds: [workspaceId],
    mode: "update",
  });
  if (locked.length === 0) {
    abortTransaction(
      new HandlerError({ status: 404, message: "Matter not found" }),
    );
  }
  const matter = await tx.query.workspaces.findFirst({
    columns: { leadUserId: true, visibility: true },
    where: { id: { eq: workspaceId }, organizationId: { eq: organizationId } },
  });
  if (!matter) {
    panic("Locked matter disappeared during steward recovery");
  }
  if (
    matter.visibility !== MATTER_VISIBILITY.assignedOnly ||
    (await hasUsableSteward(tx, {
      organizationId,
      workspaceId,
      leadUserId: matter.leadUserId,
    }))
  ) {
    abortTransaction(
      new HandlerError({
        status: 404,
        message: "Matter not found",
      }),
    );
  }
  const assignments = await tx
    .insert(workspaceMembers)
    .values({ workspaceId, userId: stewardUserId })
    .onConflictDoNothing()
    .returning({ id: workspaceMembers.id });
  await tx
    .update(workspaces)
    .set({ leadUserId: stewardUserId })
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
      ),
    );
  await recordAuditEvent(tx, [
    ...assignments.map(({ id }) => ({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER,
      resourceId: id,
      workspaceId,
      changes: { userId: { old: null, new: stewardUserId } },
    })),
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
      resourceId: workspaceId,
      workspaceId,
      changes: { leadUserId: { old: matter.leadUserId, new: stewardUserId } },
      metadata: { cause: "matter_steward_handover" },
    },
  ]);
};

/**
 * Does this user lead an assigned-only matter in the organization? Such a
 * member keeps an internal role until they hand those matters over, since an
 * external lead could not steward them.
 */
export const leadsAssignedOnlyMatter = async (
  db: Pick<Transaction, "select">,
  {
    organizationId,
    userId,
  }: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
): Promise<boolean> =>
  (
    await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, organizationId),
          eq(workspaces.leadUserId, userId),
          eq(workspaces.visibility, MATTER_VISIBILITY.assignedOnly),
        ),
      )
      .limit(1)
  ).length > 0;
