import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

import type { ReviewDelta } from "@/components/ai-suggestions/review-delta";
import { ColumnHeader } from "@/components/ai-suggestions/review-term-row";

/** The two mark columns are sized for the word they hold; the item column
 *  takes the rest, so a term reads across the row instead of wrapping one
 *  word at a time. */
const MARK_COLUMN_WIDTH = "5rem";

const CELL_CLASS = "text-sm leading-6";

type EnumerationDelta = Extract<ReviewDelta, { kind: "enumeration" }>;
type PresenceDelta = Extract<ReviewDelta, { kind: "presence" }>;

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
    <Table className="table-fixed border-collapse" density="compact">
      <colgroup>
        <col />
        <col style={{ width: MARK_COLUMN_WIDTH }} />
        <col style={{ width: MARK_COLUMN_WIDTH }} />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" />
          <ColumnHeader label={targetLabel} />
          <ColumnHeader label={standardLabel} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableHead className="min-w-0 text-start" scope="row">
              {/* The row header stays regular weight; only the marks of a
                  row missing from the target carry the emphasis. */}
              <span className={cn(!row.inTarget && "text-foreground")}>
                <RowLabel
                  citation={row.citation}
                  label={row.label}
                  onShowInDocument={row.inTarget ? onShowInDocument : undefined}
                />
              </span>
            </TableHead>
            <PresenceCell emphasis={!row.inTarget} present={row.inTarget} />
            <PresenceCell emphasis={!row.inTarget} present={row.inStandard} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
      return panic(`Unhandled delta: ${String(delta)}`);
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
    <Button
      aria-label={t("inspector.review.showInDocument")}
      onClick={() => onShowInDocument(citation.blockId)}
      variant="plain"
    >
      <BidiText
        as="span"
        className="hover:text-foreground underline decoration-dotted underline-offset-2"
      >
        {label}
      </BidiText>
    </Button>
  );
};

/** Presence in words. A reviewer should not have to work out that a hollow
 *  circle means the item is missing. */
const PresenceCell = ({
  present,
  emphasis,
}: {
  present: boolean;
  emphasis: boolean;
}) => {
  const t = useTranslations();
  return (
    <TableCell className="text-center whitespace-nowrap">
      <span
        className={cn(
          CELL_CLASS,
          present ? "text-foreground" : "text-muted-foreground",
          emphasis && "font-medium",
        )}
      >
        {present
          ? t("inspector.review.presence.present")
          : t("inspector.review.presence.absent")}
      </span>
    </TableCell>
  );
};
