import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { TableHead } from "@stll/ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import type { ReviewDelta } from "@/components/ai-suggestions/review-delta";
import {
  REVIEW_SECTION_LABEL_CLASS,
  REVIEW_SIDE_RULE_CLASS,
} from "@/components/ai-suggestions/review-passage-side";

/** A dash, not a word: the cell is hidden from assistive technology, and the
 *  column heading already says which document the empty value belongs to. */
const MISSING_VALUE_GLYPH = "—";

const CELL_CLASS = "text-sm leading-6";

export type ParameterDelta = Extract<ReviewDelta, { kind: "parameter" }>;

type TermValueProps = {
  value: ParameterDelta["target"];
  onShowInDocument?: ((blockId: string) => void) | undefined;
};

const TermValue = ({ value, onShowInDocument }: TermValueProps) => {
  const t = useTranslations();
  if (value === null) {
    return <span aria-hidden="true">{MISSING_VALUE_GLYPH}</span>;
  }
  if (onShowInDocument === undefined) {
    return <BidiText as="span">{value.text}</BidiText>;
  }
  return (
    <Button
      aria-label={t("inspector.review.showInDocument")}
      onClick={() => onShowInDocument(value.citation.blockId)}
      variant="plain"
    >
      <BidiText
        as="span"
        className="hover:text-foreground text-start underline decoration-dotted underline-offset-2"
      >
        {value.text}
      </BidiText>
    </Button>
  );
};

export type ReviewTermTableProps = {
  targetLabel: string;
  standardLabel: string;
  delta: ParameterDelta;
  onShowInDocument?: ((blockId: string) => void) | undefined;
};

/**
 * The one term this finding is about, as each side states it: two lines,
 * the reviewed document first, each carrying its side as the colour rule
 * down its edge rather than a label beside it. The card's header already
 * names the term and says which way the difference cuts, so neither is
 * repeated here; the side's name stays on the line for assistive technology
 * and in a tooltip for the pointer.
 *
 * Two lines told apart by an edge rule, not a label/value sheet: the side
 * names are hidden, so a fact-sheet grid would hold an empty label column.
 */
export const ReviewTermTable = ({
  targetLabel,
  standardLabel,
  delta,
  onShowInDocument,
}: ReviewTermTableProps) => (
  <ul className="space-y-1">
    <TermSide label={targetLabel} side="target">
      <span className={cn(CELL_CLASS, "text-foreground min-w-0 tabular-nums")}>
        <TermValue onShowInDocument={onShowInDocument} value={delta.target} />
      </span>
    </TermSide>
    <TermSide label={standardLabel} side="standard">
      <span
        className={cn(CELL_CLASS, "text-muted-foreground min-w-0 tabular-nums")}
      >
        <TermValue value={delta.standard} />
      </span>
    </TermSide>
  </ul>
);

const TermSide = ({
  label,
  side,
  children,
}: {
  label: string;
  side: keyof typeof REVIEW_SIDE_RULE_CLASS;
  children: ReactNode;
}) => (
  <li>
    <Tooltip>
      <TooltipTrigger
        render={<div className={cn("block", REVIEW_SIDE_RULE_CLASS[side])} />}
      >
        <span className="sr-only">{label}: </span>
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  </li>
);

/** A column heading that names a document: truncated to its column, with the
 *  full name in a tooltip when it is cut off, so a long reference name stays
 *  readable. */
export const ColumnHeader = ({ label }: { label: string }) => (
  <TableHead className="text-end" scope="col">
    <span className={cn(REVIEW_SECTION_LABEL_CLASS, "block font-medium")}>
      <TruncatedText>
        <BidiText as="span">{label}</BidiText>
      </TruncatedText>
    </span>
  </TableHead>
);
