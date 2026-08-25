import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type {
  ReviewDelta,
  ReviewImpact,
} from "@/components/ai-suggestions/review-delta";

// TODO(i18n): English until the review surface is localized as a whole.
const MISSING_VALUE_LABEL = "—";
const CITATION_ARIA_LABEL = "Show in document";
const IMPACT_LABEL = {
  favourable: "favourable",
  unfavourable: "unfavourable",
  neutral: "neutral",
  unknown: "unknown",
} as const satisfies Record<ReviewImpact, string>;

// Direction is encoded once, by this glyph; colour only repeats it.
const IMPACT_GLYPH = {
  favourable: "▲",
  unfavourable: "▼",
  neutral: "–",
  unknown: "–",
} as const satisfies Record<ReviewImpact, string>;
const IMPACT_GLYPH_CLASS = {
  favourable: "text-success",
  unfavourable: "text-destructive",
  neutral: "text-muted-foreground",
  unknown: "text-muted-foreground italic",
} as const satisfies Record<ReviewImpact, string>;

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
 * One term, one row: label, target value, standard value, direction. The
 * table is the only chrome; nothing here is a chip or a pill.
 */
export const ReviewTermRow = ({
  label,
  delta,
  impact,
  onShowInDocument,
}: ReviewTermRowProps) => (
  <tr className="border-border border-b last:border-b-0">
    <th
      className="text-foreground min-w-0 py-1.5 pe-3 text-start text-sm font-normal"
      scope="row"
    >
      <BidiText as="span">{label}</BidiText>
    </th>
    <td className="py-1.5 pe-3 text-end text-sm tabular-nums">
      <TermValue onShowInDocument={onShowInDocument} value={delta.target} />
    </td>
    <td className="text-muted-foreground py-1.5 pe-3 text-end text-sm tabular-nums">
      <TermValue value={delta.standard} />
    </td>
    <td className="py-1.5 text-end">
      <span className={cn("text-sm font-medium", IMPACT_GLYPH_CLASS[impact])}>
        <span aria-hidden="true">{IMPACT_GLYPH[impact]}</span>
        <span className="sr-only">{IMPACT_LABEL[impact]}</span>
      </span>
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
  <table className="w-full border-collapse">
    <thead>
      <tr className="border-border border-b">
        <th className="w-0" scope="col" />
        <th
          className="text-muted-foreground py-1 pe-3 text-end text-xs font-medium tracking-wide uppercase"
          scope="col"
        >
          <BidiText as="span">{targetLabel}</BidiText>
        </th>
        <th
          className="text-muted-foreground py-1 pe-3 text-end text-xs font-medium tracking-wide uppercase"
          scope="col"
        >
          <BidiText as="span">{standardLabel}</BidiText>
        </th>
        <th className="w-0" scope="col" />
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
