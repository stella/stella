import { useTranslations } from "use-intl";

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
    <div className="bg-muted/30 mt-3 space-y-1 rounded-md border p-2.5">
      <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {t("chat.webSearch.answer")}
      </div>
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
  );
};
