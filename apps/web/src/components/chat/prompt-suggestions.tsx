import { cn } from "@stll/ui/lib/utils";
import { useTranslations } from "use-intl";

import type { ChatPrompt } from "@/lib/prompts/types";

type PromptSuggestionsProps = {
  prompts: ChatPrompt[];
  onSelect: (prompt: ChatPrompt) => void;
  className?: string;
};

/**
 * Compact list of clickable prompt chips. Used on the chat empty
 * state in both the inspector tab and the standalone /chat
 * surface. The label above the chips ("Try one of these to start")
 * gives the affordance some weight without preempting the prompt
 * bar — a click only fills the composer; the user still sends.
 */
export const PromptSuggestions = ({
  prompts,
  onSelect,
  className,
}: PromptSuggestionsProps) => {
  const t = useTranslations();

  if (prompts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <p className="text-muted-foreground text-xs">
        {t("chat.prompts.tryOne")}
      </p>
      <div className="flex flex-col items-stretch gap-1.5 self-stretch">
        {prompts.map((prompt) => (
          <button
            className="border-border hover:border-foreground/20 hover:bg-accent/50 group flex items-center gap-2 rounded-md border px-3 py-2 text-start transition-colors"
            key={prompt.id}
            onClick={() => onSelect(prompt)}
            type="button"
          >
            <span className="text-foreground text-xs font-medium">
              {prompt.name}
            </span>
            <span className="text-muted-foreground line-clamp-1 flex-1 text-xs">
              {prompt.body}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
