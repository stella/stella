/**
 * Who can see a matter, independent of whether it has a client.
 *
 * - `organization`: the organization's owners and admins, plus the matter's
 *   members. The rule every matter with a client has always followed.
 * - `private`: only the matter's members. Owners and admins cannot open it
 *   unless they are added.
 */
export const MATTER_VISIBILITIES = ["organization", "private"] as const;

export type MatterVisibility = (typeof MATTER_VISIBILITIES)[number];

export const MATTER_VISIBILITY = {
  organization: "organization",
  private: "private",
} as const satisfies Record<MatterVisibility, MatterVisibility>;

/** A new matter is visible to the organization unless the creator chooses otherwise. */
export const DEFAULT_MATTER_VISIBILITY: MatterVisibility =
  MATTER_VISIBILITY.organization;
