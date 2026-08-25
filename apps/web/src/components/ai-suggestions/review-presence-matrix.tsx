import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type { ReviewDelta } from "@/components/ai-suggestions/review-delta";

// TODO(i18n): English until the review surface is localized as a whole.
const PRESENT_SR_LABEL = "present";
const ABSENT_SR_LABEL = "absent";
const CITATION_ARIA_LABEL = "Show in document";

const PRESENCE_MARK = { present: "●", absent: "○" } as const;

export type EnumerationDelta = Extract<ReviewDelta, { kind: "enumeration" }>;
export type PresenceDelta = Extract<ReviewDelta, { kind: "presence" }>;

type PresenceMatrixRow = {
  key: string;
  label: string;
  inTarget: boolean;
  inStandard: boolean;
  citation: { blockId: string } | null;
};

export type ReviewPresenceMatrixProps = {
  delta: EnumerationDelta | PresenceDelta;
  targetLabel: string;
  standardLabel: string;
  onShowInDocument?: ((blockId: string) => void) | undefined;
};

/**
 * One row per item (or the single term for a presence delta), two mark
 * columns. Rows missing from the target lead, with subtle emphasis: that is
 * the part of the matrix a reviewer needs to see first.
 */
export const ReviewPresenceMatrix = ({
  delta,
  targetLabel,
  standardLabel,
  onShowInDocument,
}: ReviewPresenceMatrixProps) => {
  const rows = presenceMatrixRows(delta).toSorted(
    (a, b) => Number(a.inTarget) - Number(b.inTarget),
  );

  return (
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
            className="text-muted-foreground py-1 text-end text-xs font-medium tracking-wide uppercase"
            scope="col"
          >
            <BidiText as="span">{standardLabel}</BidiText>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            className={cn(
              "border-border border-b last:border-b-0",
              !row.inTarget && "text-foreground font-medium",
            )}
            key={row.key}
          >
            <th
              className="min-w-0 py-1.5 pe-3 text-start text-sm font-normal"
              scope="row"
            >
              <RowLabel
                citation={row.citation}
                label={row.label}
                onShowInDocument={row.inTarget ? onShowInDocument : undefined}
              />
            </th>
            <td className="py-1.5 pe-3 text-end">
              <PresenceMark present={row.inTarget} />
            </td>
            <td className="py-1.5 text-end">
              <PresenceMark present={row.inStandard} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const presenceMatrixRows = (
  delta: EnumerationDelta | PresenceDelta,
): PresenceMatrixRow[] => {
  switch (delta.kind) {
    case "enumeration":
      return delta.items.map((item, index) => ({
        citation: item.citation,
        inStandard: item.inStandard,
        inTarget: item.inTarget,
        key: `${index}-${item.label}`,
        label: item.label,
      }));
    case "presence":
      return [
        {
          citation: null,
          inStandard: delta.inStandard,
          inTarget: delta.inTarget,
          key: delta.term,
          label: delta.term,
        },
      ];
    default:
      delta satisfies never;
      return [];
  }
};

type RowLabelProps = {
  label: string;
  citation: { blockId: string } | null;
  onShowInDocument?: ((blockId: string) => void) | undefined;
};

const RowLabel = ({ label, citation, onShowInDocument }: RowLabelProps) => {
  if (citation === null || onShowInDocument === undefined) {
    return <BidiText as="span">{label}</BidiText>;
  }
  return (
    <button
      aria-label={CITATION_ARIA_LABEL}
      className="hover:text-foreground underline decoration-dotted underline-offset-2"
      onClick={() => onShowInDocument(citation.blockId)}
      type="button"
    >
      <BidiText as="span">{label}</BidiText>
    </button>
  );
};

const PresenceMark = ({ present }: { present: boolean }) => (
  <span
    className={cn(
      "text-sm",
      present ? "text-foreground" : "text-muted-foreground",
    )}
  >
    <span aria-hidden="true">
      {present ? PRESENCE_MARK.present : PRESENCE_MARK.absent}
    </span>
    <span className="sr-only">
      {present ? PRESENT_SR_LABEL : ABSENT_SR_LABEL}
    </span>
  </span>
);
