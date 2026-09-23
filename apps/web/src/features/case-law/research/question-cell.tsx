/**
 * One cell of a question column.
 *
 * A question column holds the same content a matter's AI property holds, so an
 * answer is drawn by the same value renderer a matter's extracted cell is
 * drawn by: the same shapes shimmer while the model works, the same select
 * chips and dates land. What only a decision has is the source: hovering the
 * value, or the note that the decision does not state it, shows the passage
 * the model leaned on, through the workspace justification card.
 */

import type { ReactNode } from "react";

import { panic } from "better-result";
import { RefreshCwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { CaseLawResearchAnswerFailureReason } from "@stll/api-contract";
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
import type { TranslationKey } from "@/i18n/types";

const FAILURE_REASON_MESSAGE = {
  decision_unavailable:
    "caseLaw.research.answers.failureReasons.decisionUnavailable",
  no_text: "caseLaw.research.answers.failureReasons.noText",
  model_error: "caseLaw.research.answers.failureReasons.modelError",
  missing_answer: "caseLaw.research.answers.failureReasons.missingAnswer",
  wrong_type: "caseLaw.research.answers.failureReasons.wrongType",
  run_error: "caseLaw.research.answers.failureReasons.runError",
} as const satisfies Record<CaseLawResearchAnswerFailureReason, TranslationKey>;

type QuestionCellProps = {
  answersByKey: ReadonlyMap<string, QuestionAnswer>;
  column: QuestionColumn;
  decision: Decision;
  /**
   * Omitted where the organization has not granted this reader a run: the
   * failure still shows, without the button that would spend an answer on it.
   */
  onRetry?: (column: QuestionColumn, decisionId: string) => void;
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
    case "not_stated":
      return (
        <WithProvenance
          decision={decision}
          onShowPassage={onShowPassage}
          run={answer.run}
        >
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {t("caseLaw.research.answers.notStated")}
          </span>
        </WithProvenance>
      );
    case "failed": {
      // A failed cell without a reason is a writer that broke the contract.
      const reason =
        answer.failureReason ??
        panic(`Failed answer without a reason: ${answer.columnId}`);
      return (
        <span className="flex min-w-0 items-start gap-1">
          <span className="text-destructive line-clamp-2 text-sm italic">
            {t(FAILURE_REASON_MESSAGE[reason])}
          </span>
          {onRetry !== undefined && (
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
          )}
        </span>
      );
    }
    case "answered":
      return (
        <WithProvenance
          decision={decision}
          onShowPassage={onShowPassage}
          run={answer.run}
        >
          <FieldValue
            content={answer.answer ?? undefined}
            property={column}
            variant="table"
          />
        </WithProvenance>
      );
    default: {
      answer.state satisfies never;
      return panic(`Unhandled answer state: ${String(answer.state)}`);
    }
  }
};

type WithProvenanceProps = {
  children: ReactNode;
  decision: Decision;
  onShowPassage: (decision: Decision, anchorId: string) => void;
  run: QuestionAnswer["run"];
};

/**
 * A settled cell, with the model's rationale and cited passages on hover. A
 * "not stated" cell usually cites nothing, so the rationale alone is enough
 * to open the card: it is the reader's only way to see why.
 */
const WithProvenance = ({
  children,
  decision,
  onShowPassage,
  run,
}: WithProvenanceProps) => {
  if (
    !run ||
    (run.justification.blocks.length === 0 && run.rationale.length === 0)
  ) {
    return children;
  }

  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={<span className="flex w-full min-w-0 items-center" />}
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup align="start" className="w-80">
        <div className="flex flex-col gap-2 text-xs leading-relaxed">
          <p className="text-muted-foreground text-justify hyphens-auto">
            {run.rationale}
          </p>
          {run.justification.blocks.length > 0 && (
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
          )}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
};

/**
 * A cell the run has not answered yet. The field renderer shimmers in the
 * shape the column's kind will land in, which is exactly what a matter's
 * pending extraction cell does.
 */
const PENDING_CONTENT = { version: 1, type: "pending" } as const;
