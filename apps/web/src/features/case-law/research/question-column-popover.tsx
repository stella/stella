/**
 * The question a column asks, and what a reader may do to it.
 *
 * The same header menu shape a matter's property column has — edit, pin, hide,
 * answer again, delete — built from the same primitives, because from the
 * reader's side it is the same extraction engine asking the question.
 */

import { useState } from "react";

import {
  EyeOffIcon,
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
   * Omitted for a reader who may look but not act; the header then names the
   * question and offers only the arrangement every column has.
   */
  onAction?: (column: QuestionColumn, action: QuestionColumnAction) => void;
};

export const QuestionColumnPopover = ({
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
        className="min-w-56 overflow-clip *:data-[slot=popover-viewport]:p-0!"
        initialFocus={false}
      >
        {onAction !== undefined && (
          <>
            <div className="flex flex-col p-1">
              <Button
                className="justify-start gap-1.5 font-normal"
                onClick={() => act("edit")}
                size="sm"
                variant="ghost"
              >
                <PencilLineIcon />
                {t("caseLaw.research.editQuestion")}
              </Button>
            </div>
            <Separator />
          </>
        )}
        <div className="flex flex-col p-1">
          <PinProperty column={column} />
          <Button
            className="justify-start gap-1.5 font-normal"
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
        {onAction !== undefined && (
          <>
            <Separator />
            <div className="flex flex-col p-1">
              <Button
                className="justify-start gap-1.5 font-normal"
                onClick={() => act("run")}
                size="sm"
                variant="ghost"
              >
                <RefreshCwIcon />
                {t("caseLaw.research.runColumn")}
              </Button>
              <Button
                className="text-destructive justify-start gap-1.5 font-normal"
                onClick={() => act("delete")}
                size="sm"
                variant="ghost"
              >
                <Trash2Icon />
                {t("caseLaw.research.deleteColumn")}
              </Button>
            </div>
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
};
