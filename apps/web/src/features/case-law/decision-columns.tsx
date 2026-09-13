import type { JSX } from "react";

import { panic } from "better-result";

import {
  CaseNumberCell,
  CitedByCell,
  CountryPill,
  DecisionDateCell,
  DecisionLanguageCell,
  decisionYear,
  HeadnoteCell,
  SummaryCell,
} from "@/features/case-law/components/decision-cells";
import type {
  Decision,
  DecisionRenderContext,
} from "@/features/case-law/components/decision-cells";
import type { DecisionColumnId } from "@/features/case-law/decision-columns.logic";
import { normalizeCaseLawLanguageSegment } from "@/lib/case-law-route";

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
      return decision.court;
    case "country":
      return <CountryPill country={decision.country} />;
    case "date":
      return <DecisionDateCell decision={decision} />;
    case "type":
      return decision.decisionType ?? EMPTY_DECISION_VALUE;
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

/** What rows can be grouped by; every option is a column whose value is finite. */
export const DECISION_GROUP_BY_OPTIONS = [
  "none",
  "court",
  "country",
  "year",
  "type",
  "language",
] as const;

export type DecisionGroupBy = (typeof DECISION_GROUP_BY_OPTIONS)[number];

/**
 * The grouping key of a row, or null for an ungrouped table. Keys are raw
 * values (not labels) so the same decision groups the same way in every
 * locale; the caller labels them.
 */
export const decisionGroupKey = (
  groupBy: DecisionGroupBy,
  decision: Decision,
): string | null => {
  switch (groupBy) {
    case "none":
      return null;
    case "court":
      return decision.court;
    case "country":
      return decision.country;
    case "year": {
      const year = decisionYear(decision.decisionDate);
      return year === null ? "" : String(year);
    }
    case "type":
      return decision.decisionType ?? "";
    case "language":
      return normalizeCaseLawLanguageSegment(decision.language) ?? "";
    default: {
      groupBy satisfies never;
      return panic(`Unhandled group by: ${String(groupBy)}`);
    }
  }
};
