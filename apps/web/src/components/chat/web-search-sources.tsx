import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon, GlobeIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";

const collectAnswers = (parts: ChatMessage["parts"]): string[] => {
  const answers: string[] = [];
  for (const part of parts) {
    const output =
      part.type === "tool-call" &&
      part.name === "web_search" &&
      part.state === "complete"
        ? part.output
        : undefined;
    if (output?.answer) {
      answers.push(output.answer);
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
  const [open, setOpen] = useState(false);
  const answers = collectAnswers(parts);
  if (answers.length === 0) {
    return null;
  }
  return (
    <div className="bg-muted/30 mt-3 rounded-md border">
      <Collapsible onOpenChange={setOpen} open={open}>
        <CollapsibleTrigger
          render={<Button className="flex w-full" variant="plain" />}
        >
          <span className="hover:bg-muted/40 flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs">
            <DirectionalIcon
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 transition-transform",
                open && "rotate-90",
              )}
              flip={!open}
              icon={ChevronRightIcon}
            />
            <GlobeIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
              {t("chat.webSearch.answer")}
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-1 px-2.5 pb-2.5">
            {answers.map((answer, index) => (
              <p
                className="text-foreground text-sm leading-relaxed whitespace-pre-line"
                // oxlint-disable-next-line react/no-array-index-key -- answers is a read-only, immutable tool-result array from a persisted chat message; never edited/reordered by the user.
                key={`${index}-${answer.slice(0, 16)}`}
              >
                {answer}
              </p>
            ))}
            <p className="text-muted-foreground text-2xs italic">
              {t("chat.webSearch.answerDisclaimer")}
            </p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
};
