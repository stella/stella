import { SkillIcon } from "@stll/ui/icons";

import type { ActiveSkillChatContext } from "@/components/inspector/inspector-active-skill";
import { useSkillLabel } from "@/lib/knowledge/built-in-skills";

/** The skill a chat runs with, shown beside its matter picker. */
export const ChatActiveSkillLabel = ({
  skill,
}: {
  skill: ActiveSkillChatContext;
}) => {
  const skillLabel = useSkillLabel();
  return (
    <span className="text-muted-foreground text-2xs inline-flex max-w-[180px] min-w-0 shrink items-center gap-1 px-1.5 py-0.5">
      <SkillIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate" dir="auto">
        {skillLabel(skill)}
      </span>
    </span>
  );
};
