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
import { useTranslations } from "use-intl";

import type { CaseLawResearchAnswerFailureReason } from "@stll/api-contract";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { FieldValue } from "@stll/workspace-ui/field-value";

import { AiCell } from "@/components/workspaces/ai-cell";
import { questionAiCellState } from "@/components/workspaces/ai-cell-state.logic";
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
  queuedAnswerKeys?: ReadonlySet<string>;
  refusedAnswerKeys?: ReadonlySet<string>;
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
  queuedAnswerKeys,
  refusedAnswerKeys,
  column,
  decision,
  onRetry,
  onShowPassage,
}: QuestionCellProps) => {
  const t = useTranslations();
  const key = answerKey(column.id, decision.id);
  const answer = answersByKey.get(key);
  const state = questionAiCellState({
    answer,
    queued: queuedAnswerKeys?.has(key) ?? false,
    refusedBudget: refusedAnswerKeys?.has(key) ?? false,
  });
  let value: ReactNode;
  let failure: ReactNode;
  if (answer !== undefined) {
    switch (answer.state) {
      case "answered":
        value = (
          <FieldValue
            content={answer.answer ?? undefined}
            property={column}
            variant="table"
          />
        );
        break;
      case "not_stated":
        value = (
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {t("caseLaw.research.answers.notStated")}
          </span>
        );
        break;
      case "not_allowed":
        failure = t("caseLaw.research.answers.notAllowed");
        break;
      case "failed": {
        const reason =
          answer.failureReason ??
          panic(`Failed answer without a reason: ${answer.columnId}`);
        failure = t(FAILURE_REASON_MESSAGE[reason]);
        break;
      }
      case "pending":
        break;
      default:
        answer.state satisfies never;
        return panic("Unhandled answer state");
    }
  }
  return (
    <AiCell
      state={state}
      failure={failure}
      {...(onRetry !== undefined && answer?.state === "failed"
        ? { onRetry: () => onRetry(column, decision.id) }
        : {})}
    >
      <WithProvenance
        decision={decision}
        onShowPassage={onShowPassage}
        run={answer?.run}
      >
        {value}
      </WithProvenance>
    </AiCell>
  );
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
}: WithProvenanceProps): ReactNode => {
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
