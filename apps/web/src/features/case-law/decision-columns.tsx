import type { JSX } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

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
import { decisionTypeKindLabel } from "@/features/case-law/decision-filter-facets.logic";
import { getAnalytics } from "@/lib/analytics/provider";

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
        <DecisionTypeCell decision={decision} />
      );
    case "headnote":
      return <HeadnoteCell context={context} decision={decision} />;
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

const DecisionTypeCell = ({ decision }: { decision: Decision }) => {
  const t = useTranslations();
  const source = decision.decisionType ?? EMPTY_DECISION_VALUE;
  if (decision.decisionTypeKind === null) {
    reportUnclassifiedDecisionType();
    return <HighlightedText columnId="type" text={source} />;
  }
  const label = decisionTypeKindLabel(decision.decisionTypeKind, t);
  return (
    <span>
      <HighlightedText columnId="type" text={label} />
      <span className="text-muted-foreground">
        {" · "}
        <HighlightedText columnId="type" text={source} />
      </span>
    </span>
  );
};

let reportedUnclassifiedDecisionType = false;

const reportUnclassifiedDecisionType = () => {
  if (reportedUnclassifiedDecisionType) {
    return;
  }
  reportedUnclassifiedDecisionType = true;
  getAnalytics().captureError(new Error("Unclassified decision type"), {
    fingerprintKey: "caseLaw:unclassifiedDecisionType",
    scope: { type: "handler", handlerId: "case-law-decision-type-cell" },
  });
};

/** What a cell draws for a value the decision does not carry. */
const EMPTY_DECISION_VALUE = "\u2014";
