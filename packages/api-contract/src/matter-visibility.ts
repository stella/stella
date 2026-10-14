/**
 * Who can see a matter, independent of whether it has a client. Widest first:
 *
 * - `all_members`: every internal member of the organization (owner, admin,
 *   member, intern) without being assigned. External users never reach a
 *   matter through this level. What each of them may do inside it is still
 *   their organization role's matter permissions.
 * - `admins_and_assigned`: the organization's owners and admins, plus the
 *   matter's assigned members. The rule every matter with a client has
 *   always followed, and the default.
 * - `assigned_only`: only the matter's assigned members. Owners and admins
 *   cannot open it unless they are assigned.
 */
export const MATTER_VISIBILITIES = [
  "all_members",
  "admins_and_assigned",
  "assigned_only",
] as const;

export type MatterVisibility = (typeof MATTER_VISIBILITIES)[number];

export const MATTER_VISIBILITY = {
  allMembers: "all_members",
  adminsAndAssigned: "admins_and_assigned",
  assignedOnly: "assigned_only",
} as const satisfies Record<string, MatterVisibility>;

/** What a new matter gets when the caller does not choose: web, API, MCP and CLI alike. */
export const DEFAULT_MATTER_VISIBILITY: MatterVisibility =
  MATTER_VISIBILITY.adminsAndAssigned;

/** How many people a visibility reaches, relative to the others. */
const MATTER_VISIBILITY_REACH = {
  assigned_only: 0,
  admins_and_assigned: 1,
  all_members: 2,
} as const satisfies Record<MatterVisibility, number>;

/** Does moving from `from` to `to` show the matter to people who could not see it? */
export const widensMatterVisibility = (
  from: MatterVisibility,
  to: MatterVisibility,
): boolean => MATTER_VISIBILITY_REACH[to] > MATTER_VISIBILITY_REACH[from];
