import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type { ReviewDelta } from "@/components/ai-suggestions/review-delta";
import { ColumnHeader } from "@/components/ai-suggestions/review-term-row";

/** The two mark columns are sized for the word they hold; the item column
 *  takes the rest, so a term reads across the row instead of wrapping one
 *  word at a time. */
const MARK_COLUMN_WIDTH = "5rem";

const CELL_CLASS = "py-1.5 text-sm leading-6";

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
 * One row per item (or the single term for a presence delta), two columns
 * saying whether each side has it. Rows missing from the target lead, with
 * subtle emphasis: that is the part of the matrix a reviewer needs to see
 * first.
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
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col />
        <col style={{ width: MARK_COLUMN_WIDTH }} />
        <col style={{ width: MARK_COLUMN_WIDTH }} />
      </colgroup>
      <thead>
        <tr className="border-border border-b">
          <th scope="col" />
          <ColumnHeader label={targetLabel} />
          <ColumnHeader label={standardLabel} />
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
              className={cn(CELL_CLASS, "min-w-0 pe-3 text-start font-normal")}
              scope="row"
            >
              <RowLabel
                citation={row.citation}
                label={row.label}
                onShowInDocument={row.inTarget ? onShowInDocument : undefined}
              />
            </th>
            <PresenceCell present={row.inTarget} />
            <PresenceCell present={row.inStandard} />
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
  const t = useTranslations();
  if (citation === null || onShowInDocument === undefined) {
    return <BidiText as="span">{label}</BidiText>;
  }
  return (
    <button
      aria-label={t("inspector.review.showInDocument")}
      className="hover:text-foreground underline decoration-dotted underline-offset-2"
      onClick={() => onShowInDocument(citation.blockId)}
      type="button"
    >
      <BidiText as="span">{label}</BidiText>
    </button>
  );
};

/** Presence in words. A reviewer should not have to work out that a hollow
 *  circle means the item is missing. */
const PresenceCell = ({ present }: { present: boolean }) => {
  const t = useTranslations();
  return (
    <td
      className={cn(
        CELL_CLASS,
        "text-center whitespace-nowrap",
        present ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {present
        ? t("inspector.review.presence.present")
        : t("inspector.review.presence.absent")}
    </td>
  );
};
