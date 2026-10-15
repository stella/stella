import { useQuery } from "@tanstack/react-query";

import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { skillDetailOptions } from "@/lib/knowledge/queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

import type { SkillEditAccess } from "./skill-history.logic";
import { skillEditAccess } from "./skill-history.logic";

/**
 * The signed-in user's edit access to a skill. Reads as `"none"` until the
 * skill and the member role have loaded, so no affordance renders that the
 * server would then refuse.
 */
export const useSkillEditAccess = (skillId: string): SkillEditAccess => {
  const user = useAuthenticatedUser();
  const detail = useQuery(
    skillDetailOptions(user.activeOrganizationId, user.id, skillId),
  );
  const detailView = useQueryView(detail);
  useQueryViewError(detailView);
  const role = useQuery(roleOptions);
  const roleView = useQueryView(role);
  useQueryViewError(roleView);

  if (
    detailView.type !== "items" ||
    detailView.refetchError !== undefined ||
    roleView.type !== "items" ||
    roleView.refetchError !== undefined
  ) {
    return "none";
  }
  return skillEditAccess({
    scope: detailView.items.scope,
    ownerUserId: detailView.items.userId,
    origin: detailView.items.origin,
    memberRole: roleView.items,
    userId: user.id,
  });
};
