import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { readerBlockByAnchor } from "@stll/decision-reader/reader-landing";
import { Button } from "@stll/ui/button";
import { ListTreeIcon } from "@stll/ui/icons";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";

import { flattenAnalysisHeadings, getHeadingDisplayAnchorId } from "./types";
import type { AnalysisState } from "./use-decision-analysis";

type DecisionInspectorOutlineProps = {
  state: AnalysisState;
  available: boolean;
  onAnchorClick: (id: string) => void;
};

export const DecisionInspectorOutline = ({
  state,
  available,
  onAnchorClick,
}: DecisionInspectorOutlineProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  if (!available) {
    return null;
  }
  switch (state.status) {
    case "idle":
    case "generating":
    case "error":
      return null;
    case "done":
      break;
    default:
      state satisfies never;
      return panic("Unhandled decision outline state");
  }
  const headings = flattenAnalysisHeadings(state.analysis.tree);
  if (headings.length === 0) {
    return null;
  }
  const label = t("statutes.outline");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        render={<Button size="icon-xs" variant="ghost" />}
      >
        <ListTreeIcon />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-72 max-w-[calc(100vw-2rem)]"
        padding="sm"
      >
        <PopoverTitle className="mb-2">{label}</PopoverTitle>
        <ScrollArea axis="vertical" className="max-h-72">
          <nav aria-label={label}>
            <ol>
              {headings.map((heading) => (
                <li
                  key={heading.id}
                  aria-level={heading.depth + 1}
                  style={{ paddingInlineStart: heading.depth * 12 }}
                >
                  <Button
                    className="h-auto min-h-9 w-full justify-start text-start whitespace-normal"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onAnchorClick(getHeadingDisplayAnchorId(heading));
                      setOpen(false);
                    }}
                  >
                    <span dir="auto">{heading.label}</span>
                  </Button>
                </li>
              ))}
            </ol>
          </nav>
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
};

type ScrollDecisionInspectorToAnchorOptions = {
  content: HTMLElement | null;
  viewport: HTMLElement | null;
  anchorId: string;
};

/** Outline navigation belongs to the inspector viewport, never the page. */
export const scrollDecisionInspectorToAnchor = ({
  content,
  viewport,
  anchorId,
}: ScrollDecisionInspectorToAnchorOptions): void => {
  if (content === null || viewport === null) {
    return;
  }
  const target = readerBlockByAnchor(content, anchorId);
  if (target === null) {
    return;
  }
  viewport.scrollTo({
    top:
      viewport.scrollTop +
      target.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top,
  });
};
