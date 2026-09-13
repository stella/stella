import type { JSX } from "react";

import { panic } from "better-result";

import { HighlightedText } from "@/components/workspaces/table/find-highlight";
import {
  CaseNumberCell,
  CitedByCell,
  CountryPill,
  DecisionDateCell,
  DecisionLanguageCell,
  HeadnoteCell,
  SummaryCell,
} from "@/features/case-law/components/decision-cells";
import type {
  Decision,
  DecisionRenderContext,
} from "@/features/case-law/components/decision-cells";
import type { DecisionColumnId } from "@/features/case-law/decision-columns.logic";

/**
 * The one column model for decision rows, wherever they are shown: the public
 * results table and a matter's case-law panel draw the same cells, so a row
 * saved from a search looks the same in the table it lands in. Which columns
 * exist, what they are called and what a reader may do to one is data, and
 * lives in `decision-columns.logic.ts`.
 */

type DecisionCellInput = {
  column: DecisionColumnId;
  decision: Decision;
  context: DecisionRenderContext;
};

/**
 * What one decision column draws for one decision. Synchronous by type: a
 * cell is an element or text, never a promise.
 */
export const renderDecisionCell = ({
  column,
  decision,
  context,
}: DecisionCellInput): JSX.Element | string => {
  switch (column) {
    case "caseNumber":
      return <CaseNumberCell context={context} decision={decision} />;
    case "summary":
      return <SummaryCell context={context} decision={decision} />;
    case "court":
      return <HighlightedText columnId="court" text={decision.court} />;
    case "country":
      return <CountryPill country={decision.country} />;
    case "date":
      return <DecisionDateCell decision={decision} />;
    case "type":
      return decision.decisionType === null ? (
        EMPTY_DECISION_VALUE
      ) : (
        <HighlightedText columnId="type" text={decision.decisionType} />
      );
    case "headnote":
      return (
        <HeadnoteCell contentMode={context.contentMode} decision={decision} />
      );
    case "citedBy":
      return <CitedByCell decision={decision} />;
    case "language":
      return <DecisionLanguageCell decision={decision} />;
    default: {
      column satisfies never;
      return panic(`Unhandled decision column: ${String(column)}`);
    }
  }
};

/** What a cell draws for a value the decision does not carry. */
const EMPTY_DECISION_VALUE = "\u2014";
