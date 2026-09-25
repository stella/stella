import { useQuery } from "@tanstack/react-query";

import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { skillDetailOptions } from "@/lib/knowledge/queries";

import type { SkillEditAccess } from "./skill-history.logic";
import { skillEditAccess } from "./skill-history.logic";

/**
 * The signed-in user's edit access to a skill. Reads as `"none"` until the
 * skill and the member role have loaded, so no affordance renders that the
 * server would then refuse. A null id (a resource with no stored skill behind
 * it) has no access at all.
 */
export const useSkillEditAccess = (skillId: string | null): SkillEditAccess => {
  const user = useAuthenticatedUser();
  const detail = useQuery({
    ...skillDetailOptions(user.activeOrganizationId, skillId ?? ""),
    enabled: skillId !== null,
  });
  const role = useQuery(roleOptions);

  if (skillId === null || detail.data === undefined) {
    return "none";
  }
  return skillEditAccess({
    scope: detail.data.scope,
    ownerUserId: detail.data.userId,
    origin: detail.data.origin,
    memberRole: role.data,
    userId: user.id,
  });
};
