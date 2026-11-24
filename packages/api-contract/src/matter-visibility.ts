/**
 * Who can see a matter, independent of whether it has a client. Widest first:
 *
 * - `all_members`: every internal member of the organization (owner, admin,
 *   member, intern) without being assigned.
 * - `admins_and_assigned`: the organization's owners and admins, plus the
 *   matter's assigned members.
 * - `assigned_only`: only the matter's assigned members. Owners and admins
 *   do not see it unless they are assigned.
 *
 * External users never see a matter without an assignment, at any level.
 * Visibility only decides who can open a matter; what each person may do in
 * it is still their organization role's permissions.
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

export const isMatterVisibility = (value: unknown): value is MatterVisibility =>
  MATTER_VISIBILITIES.some((visibility) => visibility === value);

/**
 * What a new matter gets when the caller does not choose: web, API, MCP and
 * CLI alike. A matter without a client stays with the people assigned to it,
 * as it always has; a client matter is open to owners and admins as well.
 * Attaching or changing a client later never changes visibility.
 */
export const defaultMatterVisibilityFor = ({
  hasClient,
}: {
  hasClient: boolean;
}): MatterVisibility =>
  hasClient
    ? MATTER_VISIBILITY.adminsAndAssigned
    : MATTER_VISIBILITY.assignedOnly;

/**
 * The visibility of a stored matter. A matter saved before visibility was a
 * setting of its own has none stored; it keeps the rule it was created under,
 * decided by whether it has a client. The database rule
 * (`stella_authorized_workspace_ids`) reads the same fallback.
 */
export const effectiveMatterVisibility = ({
  visibility,
  clientId,
}: {
  visibility: MatterVisibility | null;
  clientId: string | null;
}): MatterVisibility =>
  visibility ?? defaultMatterVisibilityFor({ hasClient: clientId !== null });

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

/** A widening change was sent without confirming it. */
export const MATTER_VISIBILITY_WIDENING_UNCONFIRMED_CODE =
  "matter_visibility_widening_unconfirmed";

/**
 * A change would leave a matter visible to assigned members only without an
 * assigned internal member, so nobody could open or manage it.
 */
export const MATTER_STEWARD_HANDOVER_REQUIRED_CODE =
  "matter_steward_handover_required";
