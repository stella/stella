import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type {
  ReviewDelta,
  ReviewImpact,
} from "@/components/ai-suggestions/review-delta";
import { REVIEW_SECTION_LABEL_CLASS } from "@/components/ai-suggestions/review-passage-side";

// TODO(i18n): English until the review surface is localized as a whole.
const MISSING_VALUE_LABEL = "—";
const CITATION_ARIA_LABEL = "Show in document";

/**
 * Direction as a word. A reader who has never seen this table before has to be
 * able to read it, and an arrow needs a legend the table does not have. Muted
 * like every other secondary column: the row's place in the list already
 * carries how much it matters.
 */
const IMPACT_LABEL = {
  favourable: "Favourable",
  unfavourable: "Unfavourable",
  neutral: "Neutral",
  unknown: "Not judged",
} as const satisfies Record<ReviewImpact, string>;

/**
 * Fixed geometry, so the term reads across the row rather than wrapping a word
 * at a time while the value columns spread. The label column takes whatever is
 * left; the value and direction columns are sized for what they hold.
 */
const VALUE_COLUMN_WIDTH = "10rem";
const DIRECTION_COLUMN_WIDTH = "8rem";

const CELL_CLASS = "py-1.5 text-sm leading-6";

export type ParameterDelta = Extract<ReviewDelta, { kind: "parameter" }>;

export type ReviewTermRowData = {
  id: string;
  label: string;
  delta: ParameterDelta;
  impact: ReviewImpact;
};

export type ReviewTermRowProps = {
  label: string;
  delta: ParameterDelta;
  impact: ReviewImpact;
  onShowInDocument?: ((blockId: string) => void) | undefined;
};

/**
 * One term, one row: label, target value, standard value, direction in words.
 * The table is the only chrome; nothing here is a chip or a pill.
 */
export const ReviewTermRow = ({
  label,
  delta,
  impact,
  onShowInDocument,
}: ReviewTermRowProps) => (
  <tr className="border-border border-b last:border-b-0">
    <th
      className={cn(
        CELL_CLASS,
        "text-foreground min-w-0 pe-3 text-start font-normal",
      )}
      scope="row"
    >
      <BidiText as="span">{label}</BidiText>
    </th>
    <td className={cn(CELL_CLASS, "pe-3 text-end tabular-nums")}>
      <TermValue onShowInDocument={onShowInDocument} value={delta.target} />
    </td>
    <td
      className={cn(
        CELL_CLASS,
        "text-muted-foreground pe-3 text-end tabular-nums",
      )}
    >
      <TermValue value={delta.standard} />
    </td>
    <td
      className={cn(
        CELL_CLASS,
        "text-muted-foreground text-end whitespace-nowrap",
      )}
    >
      {IMPACT_LABEL[impact]}
    </td>
  </tr>
);

type TermValueProps = {
  value: ParameterDelta["target"];
  onShowInDocument?: ((blockId: string) => void) | undefined;
};

const TermValue = ({ value, onShowInDocument }: TermValueProps) => {
  if (value === null) {
    return <span aria-hidden="true">{MISSING_VALUE_LABEL}</span>;
  }
  if (onShowInDocument === undefined) {
    return <BidiText as="span">{value.text}</BidiText>;
  }
  return (
    <button
      aria-label={CITATION_ARIA_LABEL}
      className="hover:text-foreground underline decoration-dotted underline-offset-2"
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
  rows: readonly ReviewTermRowData[];
  onShowInDocument?: ((blockId: string) => void) | undefined;
};

/** Renders the shared header once, then one `ReviewTermRow` per term. */
export const ReviewTermTable = ({
  targetLabel,
  standardLabel,
  rows,
  onShowInDocument,
}: ReviewTermTableProps) => (
  <table className="w-full table-fixed border-collapse">
    <colgroup>
      <col />
      <col style={{ width: VALUE_COLUMN_WIDTH }} />
      <col style={{ width: VALUE_COLUMN_WIDTH }} />
      <col style={{ width: DIRECTION_COLUMN_WIDTH }} />
    </colgroup>
    <thead>
      <tr className="border-border border-b">
        <th scope="col" />
        <ColumnHeader label={targetLabel} />
        <ColumnHeader label={standardLabel} />
        <th scope="col" />
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <ReviewTermRow
          delta={row.delta}
          impact={row.impact}
          key={row.id}
          label={row.label}
          onShowInDocument={onShowInDocument}
        />
      ))}
    </tbody>
  </table>
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
