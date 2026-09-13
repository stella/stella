import { panic } from "better-result";
import { RefreshCwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type {
  CaseLawResearchAnswerType,
  CaseLawResearchYesNoValue,
} from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import type { QuestionAnswer } from "@/features/case-law/research/question-columns.logic";
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
  answer: QuestionAnswer | undefined;
  /** What the column asks for, so a pending cell shimmers in that shape. */
  answerType: CaseLawResearchAnswerType;
  /** Asks this one cell again, discarding whatever it holds. */
  onRetry: () => void;
  onShowSource: (anchorId: string) => void;
};

/**
 * One cell of a question column, drawn the way the matter table draws an
 * extracted cell: the answer's own shape shimmering while the model works, the
 * value once it lands, and a failure that says so and offers the retry. A cell
 * that was never queued reads as such and a refusal says why; nothing is ever
 * an unexplained blank.
 */
export const ResearchAnswerCell = ({
  answer,
  answerType,
  onRetry,
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
        <span
          aria-busy="true"
          aria-label={t("caseLaw.research.answers.pending")}
          className="flex min-w-0 flex-col gap-1"
          role="status"
        >
          <PendingAnswerSkeleton answerType={answerType} />
        </span>
      );
    case "not_allowed":
      return (
        <span className="text-muted-foreground text-xs">
          {t("caseLaw.research.answers.notAllowed")}
        </span>
      );
    case "failed":
      return (
        <span className="flex min-w-0 items-start gap-1">
          <span className="text-destructive line-clamp-2 text-sm italic">
            {t("caseLaw.research.answers.failed")}
          </span>
          <Button
            aria-label={t("common.retry")}
            className="text-foreground-ghost hover:text-foreground shrink-0"
            onClick={onRetry}
            size="icon-xs"
            title={t("common.retry")}
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          </Button>
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
      answer.state satisfies never;
      return panic(`Unhandled state: ${String(answer.state)}`);
    }
  }
};

/**
 * The shape the answer will take, shimmering: a chip for a yes/no, two lines
 * for a sentence. The same shapes the matter table's pending cells draw, so a
 * column still being answered reads the same on both tables.
 */
const PendingAnswerSkeleton = ({
  answerType,
}: {
  answerType: CaseLawResearchAnswerType;
}) => {
  switch (answerType) {
    case "yes_no":
      return <Skeleton className="h-4 w-16 rounded-full" />;
    case "text":
      return (
        <>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </>
      );
    default:
      answerType satisfies never;
      return panic(`Unhandled answer type: ${String(answerType)}`);
  }
};
