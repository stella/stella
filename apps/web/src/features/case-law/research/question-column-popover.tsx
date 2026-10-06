/**
 * The question a column asks, and what a reader may do to it.
 *
 * The same header menu a matter's AI property column has — edit, pin, hide,
 * rerun, delete — in the same order, with the same icons and the same strings,
 * because from the reader's side it is the same extraction engine asking the
 * question. Only the run scope differs, and the item says so; and because a
 * search picks which of the organization's questions it shows, a question can
 * also be taken off this search without deleting it.
 */

import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  EyeOffIcon,
  ListMinusIcon,
  PencilLineIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { Separator } from "@stll/ui/separator";
import { PropertyIcon } from "@stll/workspace-ui/property-icon";

import { questionAiCellState } from "@/components/workspaces/ai-cell-state.logic";
import { AiColumnRunButton } from "@/components/workspaces/ai-column-run-controls";
import {
  aiColumnRunMenu,
  aiColumnRunScope,
} from "@/components/workspaces/ai-column-run.logic";
import { PinProperty } from "@/components/workspaces/properties/pin-property";
import type {
  DecisionRowData,
  TableColumn,
} from "@/components/workspaces/table/types";
import { answerKey } from "@/features/case-law/research/question-columns.logic";
import type {
  AvailableQuestionColumns,
  QuestionColumn,
  QuestionColumnAction,
} from "@/features/case-law/research/question-columns.logic";

const NO_DECISION_IDS = [] as const;

type QuestionColumnPopoverProps = {
  column: TableColumn<DecisionRowData>;
  question: QuestionColumn;
  questions: AvailableQuestionColumns | null;
  /**
   * What this reader may do to the question. A reader the organization grants
   * nothing may only take it off this search, beside the arrangement every
   * column has.
   */
  actions: readonly QuestionColumnAction[];
  onAction?: (column: QuestionColumn, action: QuestionColumnAction) => void;
  /** Added during this visit: the header shows it and scrolls into view. */
  isNew?: boolean | undefined;
};

/**
 * Brings a header that just joined the table into view. Stable identity, so
 * React calls it when the header mounts, not on every render: a reader who
 * scrolls away afterwards is not pulled back.
 */
const scrollHeaderIntoView = (element: HTMLElement | null) => {
  element?.scrollIntoView({ block: "nearest", inline: "nearest" });
};

export const QuestionColumnPopover = ({
  actions,
  column,
  isNew = false,
  onAction,
  question,
  questions,
}: QuestionColumnPopoverProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const act = (action: QuestionColumnAction) => {
    setIsOpen(false);
    onAction?.(question, action);
  };
  const may = (action: QuestionColumnAction) =>
    onAction !== undefined && actions.includes(action);

  const stateFor = (decisionId: string) => {
    const key = answerKey(question.id, decisionId);
    return questionAiCellState({
      answer: questions?.answersByKey.get(key),
      queued: questions?.queuedAnswerKeys.has(key) ?? false,
      refusedBudget: questions?.refusedAnswerKeys.has(key) ?? false,
    });
  };
  const pageDecisionIds = questions?.pageDecisionIds ?? NO_DECISION_IDS;
  const scope = aiColumnRunScope({
    pageRowIds: pageDecisionIds,
    selectedRowIds: questions?.selectedDecisionIds ?? NO_DECISION_IDS,
  });
  const scopedStates = scope.rowIds.map(stateFor);
  const pageMenu = aiColumnRunMenu(pageDecisionIds.map(stateFor));
  const primaryRun = aiColumnRunMenu(scopedStates).at(0);

  return (
    <div className="flex h-full items-center gap-1 pe-1">
      <Popover modal onOpenChange={setIsOpen} open={isOpen}>
        <PopoverTrigger
          className="hover:bg-accent flex h-full min-w-0 flex-1 items-center gap-1.5 ps-2 pe-3 text-start"
          data-new={isNew ? "" : undefined}
          ref={isNew ? scrollHeaderIntoView : undefined}
        >
          <PropertyIcon
            className="size-3.5 shrink-0"
            type={question.content.type}
          />
          <span className="w-0 flex-1 truncate" title={question.question}>
            {question.question}
          </span>
          {isNew && (
            <span className="bg-primary/10 text-primary shrink-0 rounded-sm px-1 text-xs">
              {t("caseLaw.research.newQuestionColumn")}
            </span>
          )}
        </PopoverTrigger>
        <PopoverPopup
          align="start"
          className="min-w-56 overflow-clip"
          initialFocus={false}
          padding="none"
        >
          {may("edit") && (
            <>
              <div className="flex flex-col p-1">
                <Button
                  className="justify-start"
                  onClick={() => act("edit")}
                  size="sm"
                  variant="ghost"
                >
                  <PencilLineIcon />
                  {t("workspaces.properties.editColumn")}
                </Button>
              </div>
              <Separator />
            </>
          )}
          <div className="flex flex-col p-1">
            <PinProperty column={column} />
            <Button
              className="justify-start"
              onClick={() => {
                column.toggleVisibility(false);
                setIsOpen(false);
              }}
              size="sm"
              variant="ghost"
            >
              <EyeOffIcon />
              {t("workspaces.kanban.hideColumn")}
            </Button>
          </div>
          {may("run") && (
            <>
              <Separator />
              <div className="flex flex-col p-1">
                {pageMenu.map((item) => (
                  <Button
                    key={item.type}
                    className="justify-start"
                    disabled={
                      questions?.isRunning || pageDecisionIds.length === 0
                    }
                    onClick={() => {
                      setIsOpen(false);
                      questions?.onRunColumn(question, {
                        type: item.type,
                        scope: "page",
                      });
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {item.type === "remaining" ? (
                      <PlayIcon />
                    ) : (
                      <RefreshCwIcon />
                    )}
                    {t(item.label)}
                  </Button>
                ))}
              </div>
            </>
          )}
          {(may("remove") || may("delete")) && (
            <>
              <Separator />
              {/* Off this search, or out of the organization: two ends of one
                decision, so they sit together. */}
              <div className="flex flex-col p-1">
                {may("remove") && (
                  <Button
                    className="justify-start"
                    onClick={() => act("remove")}
                    size="sm"
                    variant="ghost"
                  >
                    <ListMinusIcon />
                    {t("caseLaw.research.removeFromSearch")}
                  </Button>
                )}
                {may("delete") && (
                  <Button
                    className="text-destructive justify-start"
                    onClick={() => act("delete")}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2Icon />
                    {t("workspaces.properties.deleteProperty")}
                  </Button>
                )}
              </div>
            </>
          )}
        </PopoverPopup>
      </Popover>
      {may("run") && questions !== null && (
        <AiColumnRunButton
          scope={scope}
          hasNotRun={scopedStates.some((state) => state.type === "not_run")}
          disabled={
            questions.isRunning || scope.count === 0 || primaryRun === undefined
          }
          onRun={() => {
            if (primaryRun === undefined) {
              return;
            }
            questions.onRunColumn(question, {
              type: primaryRun.type,
              scope: scope.type,
            });
          }}
        />
      )}
    </div>
  );
};
