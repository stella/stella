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
    <div className={cn("flex w-full flex-col items-center gap-3", className)}>
      <p className="text-muted-foreground text-sm">
        {t("chat.prompts.tryOne")}
      </p>
      <div className="flex w-full flex-col items-stretch gap-2">
        {prompts.map((prompt) => (
          <button
            className="border-border hover:border-foreground/20 hover:bg-accent/50 group flex gap-3 rounded-md border px-4 py-3 text-start transition-colors"
            key={prompt.id}
            onClick={() => onSelect(prompt)}
            type="button"
          >
            <span className="text-muted-foreground/55 group-hover:text-muted-foreground mt-0.5 flex size-4 shrink-0 items-center justify-center font-mono text-[13px] leading-none transition-colors">
              /
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground block text-sm leading-5 font-medium">
                {prompt.name}
              </span>
              <span className="text-muted-foreground line-clamp-2 text-xs leading-4">
                {prompt.body}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
