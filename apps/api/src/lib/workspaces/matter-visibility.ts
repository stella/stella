import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

import {
  defaultMatterVisibilityFor,
  effectiveMatterVisibility,
  MATTER_VISIBILITIES,
} from "@stll/api-contract/matter-visibility";
import type { MatterVisibility } from "@stll/api-contract/matter-visibility";

import { workspaces } from "@/api/db/schema";

export { defaultMatterVisibilityFor, effectiveMatterVisibility };
export type { MatterVisibility };

const VISIBILITY_DESCRIPTION =
  "Who can open the matter without being assigned: all_members (every " +
  "internal member), admins_and_assigned (owners and admins) or " +
  "assigned_only (nobody). External users always need an assignment.";

/** The visibility a request may name. */
export const matterVisibilitySchema = (description = VISIBILITY_DESCRIPTION) =>
  v.pipe(v.picklist(MATTER_VISIBILITIES), v.description(description));

/**
 * The stored visibility of `workspaces`, with the client fallback for a
 * matter saved before visibility was stored. The same expression the
 * database rule reads.
 */
export const effectiveMatterVisibilitySql = (): SQL<MatterVisibility> =>
  sql<MatterVisibility>`COALESCE(${workspaces.visibility}, CASE WHEN ${workspaces.clientId} IS NULL THEN 'assigned_only' ELSE 'admins_and_assigned' END)`;

/**
 * Whether an organization role reaches the matter without an assignment,
 * asked of the database (`stella_role_reaches_matter`). Lock scopes use it to
 * choose which rows to hold; access itself is always decided afterwards by
 * `stella_workspace_access`.
 */
export const roleReachesMatterSql = (
  role: SQLWrapper | string,
  /** The matter's columns; `workspaces` when omitted. */
  matter?: { visibility: SQLWrapper; clientId: SQLWrapper },
): SQL<boolean> =>
  sql<boolean>`stella_role_reaches_matter(${role}::text, ${matter?.visibility ?? workspaces.visibility}::text, ${matter?.clientId ?? workspaces.clientId}::uuid)`;
