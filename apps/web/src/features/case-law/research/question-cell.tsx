/**
 * One cell of a question column.
 *
 * A question column holds the same content a matter's AI property holds, so an
 * answer is drawn by the same value renderer a matter's extracted cell is
 * drawn by: the same shapes shimmer while the model works, the same select
 * chips and dates land, the same wording says a value is missing. What only a
 * decision has is the source: hovering the value shows the passage the model
 * leaned on, through the workspace justification card.
 */

import { panic } from "better-result";
import { RefreshCwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { FieldValue } from "@stll/workspace-ui/field-value";

import { Justification } from "@/components/workspaces/justification";
import type { Decision } from "@/features/case-law/components/decision-cells";
import { answerKey } from "@/features/case-law/research/question-columns.logic";
import type {
  QuestionAnswer,
  QuestionColumn,
} from "@/features/case-law/research/question-columns.logic";

type QuestionCellProps = {
  answersByKey: ReadonlyMap<string, QuestionAnswer>;
  column: QuestionColumn;
  decision: Decision;
  onRetry: (column: QuestionColumn, decisionId: string) => void;
  onShowPassage: (decision: Decision, anchorId: string) => void;
};

export const QuestionCell = ({
  answersByKey,
  column,
  decision,
  onRetry,
  onShowPassage,
}: QuestionCellProps) => {
  const t = useTranslations();
  const answer = answersByKey.get(answerKey(column.id, decision.id));

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
        <FieldValue
          content={PENDING_CONTENT}
          property={column}
          variant="table"
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
        <span className="flex min-w-0 items-start gap-1">
          <span className="text-destructive line-clamp-2 text-sm italic">
            {t("caseLaw.research.answers.failed")}
          </span>
          <Button
            aria-label={t("common.retry")}
            className="text-foreground-ghost hover:text-foreground shrink-0"
            onClick={() => onRetry(column, decision.id)}
            size="icon-xs"
            title={t("common.retry")}
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </span>
      );
    case "answered": {
      const value = (
        <FieldValue
          content={answer.answer ?? undefined}
          property={column}
          variant="table"
        />
      );
      const run = answer.run;
      if (!run || run.justification.blocks.length === 0) {
        return value;
      }

      return (
        <PreviewCard>
          <PreviewCardTrigger
            render={<span className="flex w-full min-w-0 items-center" />}
          >
            {value}
          </PreviewCardTrigger>
          <PreviewCardPopup align="start" className="w-80">
            <div className="flex flex-col gap-2 text-xs leading-relaxed">
              <p className="text-muted-foreground text-justify hyphens-auto">
                {run.rationale}
              </p>
              <div className="text-foreground-strong-muted wrap-break-word">
                <Justification
                  source={{
                    kind: "decision",
                    content: run.justification,
                    onOpenPassage: (anchorId) =>
                      onShowPassage(decision, anchorId),
                  }}
                />
              </div>
            </div>
          </PreviewCardPopup>
        </PreviewCard>
      );
    }
    default: {
      answer.state satisfies never;
      return panic(`Unhandled answer state: ${String(answer.state)}`);
    }
  }
};

/**
 * A cell the run has not answered yet. The field renderer shimmers in the
 * shape the column's kind will land in, which is exactly what a matter's
 * pending extraction cell does.
 */
const PENDING_CONTENT = { version: 1, type: "pending" } as const;
