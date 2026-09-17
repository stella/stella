import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
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
    <button
      aria-label={t("inspector.review.showInDocument")}
      className="hover:text-foreground text-start underline decoration-dotted underline-offset-2"
      onClick={() => onShowInDocument(value.citation.blockId)}
      type="button"
    >
      <BidiText as="span">{value.text}</BidiText>
    </button>
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
 * repeated here; the side's name stays on the element for assistive
 * technology and the pointer.
 */
export const ReviewTermTable = ({
  targetLabel,
  standardLabel,
  delta,
  onShowInDocument,
}: ReviewTermTableProps) => (
  <dl className="space-y-1">
    <div className={REVIEW_SIDE_RULE_CLASS.target} title={targetLabel}>
      <dt className="sr-only">{targetLabel}</dt>
      <dd className={cn(CELL_CLASS, "text-foreground min-w-0 tabular-nums")}>
        <TermValue onShowInDocument={onShowInDocument} value={delta.target} />
      </dd>
    </div>
    <div className={REVIEW_SIDE_RULE_CLASS.standard} title={standardLabel}>
      <dt className="sr-only">{standardLabel}</dt>
      <dd
        className={cn(CELL_CLASS, "text-muted-foreground min-w-0 tabular-nums")}
      >
        <TermValue value={delta.standard} />
      </dd>
    </div>
  </dl>
);

/** A column heading that names a document: truncated to its column, with the
 *  full name on the element itself so a long reference name stays readable. */
export const ColumnHeader = ({ label }: { label: string }) => (
  <th
    className={cn(REVIEW_SECTION_LABEL_CLASS, "py-1 pe-3 text-end font-medium")}
    scope="col"
    title={label}
  >
    <BidiText as="span" className="block truncate">
      {label}
    </BidiText>
  </th>
);
