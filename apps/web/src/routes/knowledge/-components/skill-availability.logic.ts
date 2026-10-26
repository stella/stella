import { panic } from "better-result";

import { type SafeId, toSafeId } from "@/lib/safe-id";

export type SkillScope = "team" | "private";

/**
 * Where a new skill can be used: everywhere its scope reaches, only in one
 * matter, or only in one client's matters. Chosen at creation; the server
 * refuses to change it later.
 */
export type SkillAvailability = "everywhere" | "matter" | "client";

/**
 * The availabilities the caller may pick for `scope`. Binding to a client is
 * for admins and owners; a team skill without a binding is too, so a member
 * sharing a skill with the team binds it to a matter they reach.
 */
export const skillAvailabilityOptions = ({
  canManageTeam,
  scope,
}: {
  canManageTeam: boolean;
  scope: SkillScope;
}): readonly SkillAvailability[] => {
  if (canManageTeam) {
    return ["everywhere", "matter", "client"];
  }
  return scope === "team" ? ["matter"] : ["everywhere", "matter"];
};

/**
 * Keeps the current choice when the new scope still allows it, otherwise
 * falls back to the first allowed one (for a member switching to team scope,
 * that is "one matter").
 */
export const coerceSkillAvailability = ({
  availability,
  canManageTeam,
  scope,
}: {
  availability: SkillAvailability;
  canManageTeam: boolean;
  scope: SkillScope;
}): SkillAvailability => {
  if (
    skillAvailabilityOptions({ canManageTeam, scope }).includes(availability)
  ) {
    return availability;
  }
  // Only a member's team scope narrows the choice, and it allows one matter.
  return "matter";
};

export type SkillBindingBody =
  | Record<string, never>
  | { boundWorkspaceId: SafeId<"workspace"> }
  | { boundClientId: SafeId<"contact"> };

/**
 * The binding fields a create request carries, or `null` while the chosen
 * matter or client is still missing (the request cannot be sent yet).
 */
export const skillBindingBody = ({
  availability,
  clientId,
  matterId,
}: {
  availability: SkillAvailability;
  clientId: string | null;
  matterId: string | null;
}): SkillBindingBody | null => {
  switch (availability) {
    case "everywhere":
      return {};
    case "matter":
      return matterId === null
        ? null
        : { boundWorkspaceId: toSafeId<"workspace">(matterId) };
    case "client":
      return clientId === null
        ? null
        : { boundClientId: toSafeId<"contact">(clientId) };
    default:
      availability satisfies never;
      return panic(`Unhandled skill availability: ${String(availability)}`);
  }
};
