import { useTranslations } from "use-intl";

import type { CaseLawResearchYesNoValue } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import type { ResearchAnswer } from "@/features/case-law/research/queries";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

export const YES_NO_LABEL_KEYS = {
  yes: "caseLaw.research.answers.yes",
  no: "caseLaw.research.answers.no",
  unclear: "caseLaw.research.answers.unclear",
} as const satisfies Record<CaseLawResearchYesNoValue, TranslationKey>;

const YES_NO_TONE = {
  yes: "bg-success/15 text-success",
  no: "bg-destructive/10 text-destructive",
  unclear: "bg-muted text-muted-foreground",
} as const satisfies Record<CaseLawResearchYesNoValue, string>;

type ResearchAnswerCellProps = {
  /** Absent when the cell was never queued. */
  answer: ResearchAnswer | undefined;
  onShowSource: (anchorId: string) => void;
};

/**
 * One cell of a question column. Every state has a face: a cell that was never
 * queued reads as such, a pending one shimmers, a refusal says why. Nothing is
 * ever an unexplained blank.
 */
export const ResearchAnswerCell = ({
  answer,
  onShowSource,
}: ResearchAnswerCellProps) => {
  const t = useTranslations();
  const format = useFormatter();

  if (answer === undefined) {
    return (
      <span className="text-foreground-placeholder text-xs">
        {t("caseLaw.research.answers.notRun")}
      </span>
    );
  }
  switch (answer.state) {
    case "pending":
      return (
        <Skeleton
          aria-label={t("caseLaw.research.answers.pending")}
          className="h-4 w-16"
        />
      );
    case "not_allowed":
      return (
        <span className="text-muted-foreground text-xs">
          {t("caseLaw.research.answers.notAllowed")}
        </span>
      );
    case "failed":
      return (
        <span className="text-muted-foreground text-xs">
          {t("caseLaw.research.answers.failed")}
        </span>
      );
    case "answered": {
      const value = answer.answer;
      if (value === null) {
        return null;
      }
      const source = answer.run?.passages.at(0);
      const confidence =
        answer.confidence === null
          ? null
          : t("caseLaw.research.answers.confidence", {
              percent: format.number(Math.round(answer.confidence * 100)),
            });
      return (
        <div className="flex flex-col items-start gap-1">
          {value.type === "yes_no" ? (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-xs font-medium",
                YES_NO_TONE[value.value],
              )}
            >
              {t(YES_NO_LABEL_KEYS[value.value])}
            </span>
          ) : (
            <span className="text-foreground text-sm">{value.value}</span>
          )}
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            {confidence !== null && <span>{confidence}</span>}
            {source !== undefined && (
              <Button
                className="h-auto px-0 py-0 text-xs"
                onClick={() => onShowSource(source.anchorId)}
                size="sm"
                title={answer.run?.rationale}
                variant="link"
              >
                {t("caseLaw.research.answers.showSource")}
              </Button>
            )}
          </span>
        </div>
      );
    }
    default: {
      const exhaustive: never = answer.state;
      return exhaustive;
    }
  }
};
