import { useInfiniteQuery } from "@tanstack/react-query";

import { SkillIcon } from "@stll/ui/icons";

import type { ActiveSkillChatContext } from "@/components/inspector/inspector-active-skill";
import { skillLabel } from "@/components/inspector/inspector-store-types";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { skillsOptions } from "@/lib/knowledge/queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

/**
 * The title of a built-in skill as the skills list serves it. Read only
 * when the skill carries no title of its own, so the list is fetched
 * where nothing else has, and the name stays the fallback until it
 * arrives or when the list fails.
 */
const useBuiltInSkillTitle = (
  skill: ActiveSkillChatContext,
): string | undefined => {
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const skillsQuery = useInfiniteQuery({
    ...skillsOptions(activeOrganizationId, userId),
    enabled: skill.skillDisplayName === undefined,
  });
  const skillsView = useQueryView(skillsQuery);
  useQueryViewError(skillsView);
  if (skill.skillDisplayName !== undefined || skillsView.type !== "items") {
    return undefined;
  }
  return skillsView.items.pages
    .at(0)
    ?.builtIn.find(({ slug }) => slug === skill.skillName)?.name;
};

/** The skill a chat runs with, shown beside its matter picker. */
export const ChatActiveSkillLabel = ({
  skill,
}: {
  skill: ActiveSkillChatContext;
}) => {
  const builtInTitle = useBuiltInSkillTitle(skill);
  return (
    <span className="text-muted-foreground text-2xs inline-flex max-w-[180px] min-w-0 shrink items-center gap-1 px-1.5 py-0.5">
      <SkillIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate" dir="auto">
        {builtInTitle ?? skillLabel(skill)}
      </span>
    </span>
  );
};
