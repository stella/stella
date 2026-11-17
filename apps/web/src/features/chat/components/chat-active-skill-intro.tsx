import { SkillIcon } from "@stll/ui/icons";

import { PromptSuggestions } from "@/components/chat/prompt-suggestions";
import type { ActiveSkillChatContext } from "@/components/inspector/inspector-active-skill";
import { useActiveSkillIntro } from "@/lib/knowledge/built-in-skills";
import type { PromptSuggestion } from "@/lib/prompts/types";

type ChatActiveSkillIntroProps = {
  skill: ActiveSkillChatContext;
  onSelectPrompt: (prompt: PromptSuggestion) => void;
};

/** What an empty chat says about the skill it runs with. */
export const ChatActiveSkillIntro = ({
  skill,
  onSelectPrompt,
}: ChatActiveSkillIntroProps) => {
  const { title, description, prompts } = useActiveSkillIntro(skill);
  return (
    <div
      className="flex w-full flex-col items-center gap-6"
      data-slot="chat-active-skill-intro"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <SkillIcon
          aria-hidden="true"
          className="text-muted-foreground size-5"
        />
        <h2
          className="text-foreground text-base font-medium text-balance"
          dir="auto"
        >
          {title}
        </h2>
        {description !== undefined && (
          <p className="text-muted-foreground text-sm text-pretty" dir="auto">
            {description}
          </p>
        )}
      </div>
      <PromptSuggestions onSelect={onSelectPrompt} prompts={prompts} />
    </div>
  );
};
