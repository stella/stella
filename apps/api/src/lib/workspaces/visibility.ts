import { eq } from "drizzle-orm";
import { t } from "elysia";

import { MATTER_VISIBILITY } from "@stll/api-contract";
import type { MatterVisibility } from "@stll/api-contract";
import { ORGANIZATION_MATTER_ADMIN_ROLES } from "@stll/permissions";

import { workspaces } from "@/api/db/schema";

/**
 * SQL predicate: the matter is visible to the organization, so its owners and
 * admins reach it without being members. Mirrors the third branch of the
 * stella_authorized_workspaces view.
 */
export const isOrganizationVisibleMatter = () =>
  eq(workspaces.visibility, MATTER_VISIBILITY.organization);

/**
 * Does this organization role reach a matter of this visibility without a
 * membership row? Only owners and admins, and only organization-visible
 * matters; a private matter is reachable through membership alone.
 */
export const reachesMatterWithoutMembership = ({
  role,
  visibility,
}: {
  role: string;
  visibility: MatterVisibility;
}): boolean =>
  visibility === MATTER_VISIBILITY.organization &&
  ORGANIZATION_MATTER_ADMIN_ROLES.some((adminRole) => adminRole === role);

/**
 * Request schema for a matter visibility. A literal union rather than
 * `t.UnionEnum`: wrapped in `t.Optional`, a union enum coerces an absent field
 * to its first member, which would turn "not stated" into "organization".
 */
export const tMatterVisibility = (options?: { description?: string }) =>
  t.Union(
    [
      t.Literal(MATTER_VISIBILITY.organization),
      t.Literal(MATTER_VISIBILITY.private),
    ],
    options,
  );
