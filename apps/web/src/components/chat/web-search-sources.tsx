import { ChevronRightIcon, GlobeIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";

const WEB_SEARCH_PART_TYPE = "tool-web_search";

const collectAnswers = (parts: ChatMessage["parts"]): string[] => {
  const answers: string[] = [];
  for (const part of parts) {
    if (
      part.type === WEB_SEARCH_PART_TYPE &&
      part.state === "output-available" &&
      part.output.answer
    ) {
      answers.push(part.output.answer);
    }
  }
  return answers;
};

type WebSearchSourcesProps = {
  parts: ChatMessage["parts"];
};

/**
 * Renders the Tavily-synthesized `answer` block above the message
 * text. The per-source chip strip is handled by the canonical
 * <SourceChips> component — adding our own would render every URL
 * twice (once here, once via collectExternalSources downstream).
 */
export const WebSearchSources = ({ parts }: WebSearchSourcesProps) => {
  const t = useTranslations();
  const answers = collectAnswers(parts);
  if (answers.length === 0) {
    return null;
  }
  return (
    <details className="bg-muted/30 group/web-summary mt-3 rounded-md border">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5",
          "px-2.5 py-1.5 text-xs",
          "[&::-webkit-details-marker]:hidden",
          "hover:bg-muted/40 rounded-md transition-colors",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform",
            "group-open/web-summary:rotate-90",
          )}
        />
        <GlobeIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {t("chat.webSearch.answer")}
        </span>
      </summary>
      <div className="space-y-1 px-2.5 pb-2.5">
        {answers.map((answer, index) => (
          <p
            className="text-foreground text-sm leading-relaxed whitespace-pre-line"
            key={`${index}-${answer.slice(0, 16)}`}
          >
            {answer}
          </p>
        ))}
        <p className="text-muted-foreground text-[11px] italic">
          {t("chat.webSearch.answerDisclaimer")}
        </p>
      </div>
    </details>
  );
};
