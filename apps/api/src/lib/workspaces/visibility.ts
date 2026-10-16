import { panic } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import { MATTER_VISIBILITY } from "@stll/api-contract";
import type { MatterVisibility } from "@stll/api-contract";
import {
  INTERNAL_MEMBER_ROLES,
  ORGANIZATION_MATTER_ADMIN_ROLES,
} from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMatterAccessWorkspaceRows,
  withAggregateRowQuery,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";

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
 * SQL predicate for a caller already known to be an owner or admin: the
 * joined matter is one they reach without an assignment.
 */
export const isAdminReachableMatter = () =>
  inArray(workspaces.visibility, ADMIN_REACHABLE_VISIBILITIES);

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

/**
 * Request schema for a matter visibility. A literal union rather than
 * `t.UnionEnum`: wrapped in `t.Optional`, a union enum coerces an absent field
 * to its first member, which would turn "not stated" into the widest level.
 */
export const tMatterVisibility = (options?: { description?: string }) =>
  t.Union(
    [
      t.Literal(MATTER_VISIBILITY.allMembers),
      t.Literal(MATTER_VISIBILITY.adminsAndAssigned),
      t.Literal(MATTER_VISIBILITY.assignedOnly),
    ],
    options,
  );

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
  // The matter row is the invariant's lock: holding it before reading the
  // lead's role and assignment means a concurrent role change (whose member
  // trigger locks this row) or lead removal either committed already
  // and is read here, or waits for this transaction and then sees its result.
  await withAggregateRowQuery({
    tx,
    aggregate: "workspace",
    id: { id: workspaceId, organizationId },
    mode: "update",
    select: (lockTx) =>
      lockTx
        .select({
          id: workspaces.id,
          organizationId: workspaces.organizationId,
        })
        .from(workspaces),
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
 * leaves. With no other internal assignee, widen to admins-and-assigned in
 * the same audited update that clears the lead. The departing user is never
 * chosen. Locks serialize the candidate read with membership/assignment loss.
 */
export const restoreMatterStewards = async (
  tx: Transaction,
  {
    organizationId,
    workspaceIds,
    departingUserId,
    recordAuditEvent,
  }: {
    organizationId: SafeId<"organization">;
    workspaceIds: readonly SafeId<"workspace">[];
    departingUserId: string;
    recordAuditEvent: AuditRecorder;
  },
): Promise<void> => {
  if (workspaceIds.length === 0) {
    return;
  }
  const requested = [...new Set(workspaceIds)];
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
        lead_user_id = steward.user_id,
        visibility = CASE
          WHEN steward.user_id IS NULL THEN ${MATTER_VISIBILITY.adminsAndAssigned}
          ELSE w.visibility
        END
      FROM broken
      LEFT JOIN steward ON steward.workspace_id = broken.id
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
        changes: {
          leadUserId: { old: oldLeadUserId, new: leadUserId },
          ...(leadUserId === null
            ? {
                visibility: {
                  old: MATTER_VISIBILITY.assignedOnly,
                  new: MATTER_VISIBILITY.adminsAndAssigned,
                },
              }
            : {}),
        },
        metadata: {
          cause: "matter_steward_restored",
          ...(leadUserId === null ? { visibilityChange: "widened" } : {}),
        },
      }),
    ),
  );
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
