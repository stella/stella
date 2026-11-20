import { useQuery } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";

import {
  type ActiveSkillChatContext,
  skillEditorChatSkill,
} from "@/components/inspector/inspector-active-skill";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { skillDetailOptions } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/**
 * The organization skill the main view's editor shows, named as its own
 * new-chat button names it; `undefined` on every other route and until the
 * skill's detail (the editor's own query) has loaded.
 */
export const useMainSkill = (): ActiveSkillChatContext | undefined => {
  const skillId = useMatch({
    from: "/knowledge/tools_/skills/$skillId",
    shouldThrow: false,
    select: (match) => match.params.skillId,
  });
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const detailQuery = useQuery({
    ...skillDetailOptions(activeOrganizationId, userId, skillId ?? ""),
    enabled: skillId !== undefined,
  });
  const detailView = queryView(detailQuery);
  useQueryViewError(detailView, "useMainSkill:query");
  if (skillId === undefined || detailView.type !== "items") {
    return undefined;
  }
  return skillEditorChatSkill({
    name: detailView.items.name,
    skillId,
    slug: detailView.items.slug,
  });
};
