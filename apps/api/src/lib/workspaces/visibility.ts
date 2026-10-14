import { panic } from "better-result";
import { and, eq, inArray, or } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { t } from "elysia";

import { MATTER_VISIBILITY } from "@stll/api-contract";
import type { MatterVisibility } from "@stll/api-contract";
import {
  INTERNAL_MEMBER_ROLES,
  ORGANIZATION_MATTER_ADMIN_ROLES,
} from "@stll/permissions";

import { workspaces } from "@/api/db/schema";

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
 * this way.
 */
export const reachesMatterWithoutAssignmentSql = (
  role: SQLWrapper,
): SQL | undefined =>
  or(
    and(
      inArray(role, ORGANIZATION_MATTER_ADMIN_ROLES),
      inArray(workspaces.visibility, ADMIN_REACHABLE_VISIBILITIES),
    ),
    and(
      inArray(role, INTERNAL_MEMBER_ROLES),
      eq(workspaces.visibility, MATTER_VISIBILITY.allMembers),
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
