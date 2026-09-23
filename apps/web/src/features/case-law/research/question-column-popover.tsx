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

import {
  EyeOffIcon,
  ListMinusIcon,
  PencilLineIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { Separator } from "@stll/ui/separator";
import { PropertyIcon } from "@stll/workspace-ui/property-icon";

import { PinProperty } from "@/components/workspaces/properties/pin-property";
import type {
  DecisionRowData,
  TableColumn,
} from "@/components/workspaces/table/types";
import type {
  QuestionColumn,
  QuestionColumnAction,
} from "@/features/case-law/research/question-columns.logic";

type QuestionColumnPopoverProps = {
  column: TableColumn<DecisionRowData>;
  question: QuestionColumn;
  /**
   * What this reader may do to the question. A reader the organization grants
   * nothing may only take it off this search, beside the arrangement every
   * column has.
   */
  actions: readonly QuestionColumnAction[];
  onAction?: (column: QuestionColumn, action: QuestionColumnAction) => void;
};

export const QuestionColumnPopover = ({
  actions,
  column,
  onAction,
  question,
}: QuestionColumnPopoverProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const act = (action: QuestionColumnAction) => {
    setIsOpen(false);
    onAction?.(question, action);
  };
  const may = (action: QuestionColumnAction) =>
    onAction !== undefined && actions.includes(action);

  return (
    <Popover modal onOpenChange={setIsOpen} open={isOpen}>
      <PopoverTrigger className="hover:bg-accent flex h-full w-full items-center gap-1.5 ps-2 pe-3 text-start">
        <PropertyIcon
          className="size-3.5 shrink-0"
          type={question.content.type}
        />
        <span className="w-0 flex-1 truncate" title={question.question}>
          {question.question}
        </span>
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
              <Button
                className="justify-start"
                onClick={() => act("run")}
                size="sm"
                variant="ghost"
              >
                <RefreshCwIcon />
                {t("workspaces.properties.rerunColumn")}
                {/* The matter runs its column over the whole table; a question
                    runs over the page in front of the reader, so the scope is
                    said rather than assumed. */}
                <span className="text-muted-foreground">
                  {t("common.scopeThisPage")}
                </span>
              </Button>
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
  );
};
