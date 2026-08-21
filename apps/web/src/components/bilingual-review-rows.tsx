/**
 * The row half of the bilingual-translation review: what happens to every row
 * of the document's right-hand column. Virtualized because a document may
 * carry thousands of rows and each one owns a picker.
 */

import { useState } from "react";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import {
  annotatedOriginLabelKey,
  BILINGUAL_DISPOSITION_LABEL_KEYS,
  BILINGUAL_ROW_KIND_LABEL_KEYS,
  isBilingualRowDisposition,
  type BilingualPreparedRow,
  type BilingualRowDisposition,
} from "@/components/bilingual-translate-queries";

type BilingualReviewRowsProps = {
  rows: BilingualPreparedRow[];
  disabled: boolean;
  onDispositionChange: (
    rowId: string,
    disposition: BilingualRowDisposition,
  ) => void;
};

const ROW_HEIGHT_PX = 48;
const ROW_OVERSCAN = 8;

export const BilingualReviewRows = ({
  rows,
  disabled,
  onDispositionChange,
}: BilingualReviewRowsProps) => {
  const t = useTranslations();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: scrollElement !== null,
    estimateSize: () => ROW_HEIGHT_PX,
    getItemKey: (index) => rows.at(index)?.rowId ?? index,
    getScrollElement: () => scrollElement,
    overscan: ROW_OVERSCAN,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows.at(0)?.start ?? 0;
  const paddingBottom =
    virtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0);

  return (
    <div
      className="max-h-72 overflow-y-auto rounded-md border"
      ref={setScrollElement}
    >
      <Table>
        <TableHeader className="bg-background sticky top-0 z-10">
          <TableRow>
            <TableHead className="w-10">
              {t("bilingualTranslate.rows.ordinal")}
            </TableHead>
            <TableHead>{t("bilingualTranslate.rows.sourceText")}</TableHead>
            <TableHead className="w-28">{t("common.kind")}</TableHead>
            <TableHead className="w-48">
              {t("bilingualTranslate.rows.whatToDo")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paddingTop > 0 && (
            <TableRow>
              <TableCell colSpan={4} style={{ height: paddingTop }} />
            </TableRow>
          )}
          {virtualRows.map((virtualRow) => {
            const row = rows.at(virtualRow.index);
            if (row === undefined) {
              return null;
            }
            return (
              <BilingualReviewRow
                disabled={disabled}
                key={row.rowId}
                onDispositionChange={onDispositionChange}
                row={row}
              />
            );
          })}
          {paddingBottom > 0 && (
            <TableRow>
              <TableCell colSpan={4} style={{ height: paddingBottom }} />
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
};

type BilingualReviewRowProps = {
  row: BilingualPreparedRow;
  disabled: boolean;
  onDispositionChange: (
    rowId: string,
    disposition: BilingualRowDisposition,
  ) => void;
};

const BilingualReviewRow = ({
  row,
  disabled,
  onDispositionChange,
}: BilingualReviewRowProps) => {
  const t = useTranslations();
  const originKey = annotatedOriginLabelKey(row.dispositionOrigin);

  return (
    <TableRow style={{ height: ROW_HEIGHT_PX }}>
      <TableCell className="text-muted-foreground tabular-nums">
        {row.ordinal + 1}
      </TableCell>
      <TableCell className="max-w-0">
        <span className="block truncate" title={row.sourceText}>
          {row.sourceText}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {t(BILINGUAL_ROW_KIND_LABEL_KEYS[row.kind])}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Select
            disabled={disabled}
            onValueChange={(value) => {
              if (isBilingualRowDisposition(value)) {
                onDispositionChange(row.rowId, value);
              }
            }}
            value={row.disposition}
          >
            <SelectTrigger
              aria-label={t("bilingualTranslate.rows.whatToDo")}
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {Object.entries(BILINGUAL_DISPOSITION_LABEL_KEYS).map(
                ([disposition, labelKey]) => (
                  <SelectItem key={disposition} value={disposition}>
                    {t(labelKey)}
                  </SelectItem>
                ),
              )}
            </SelectPopup>
          </Select>
          {originKey !== null && (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px]">
              {t(originKey)}
            </span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
};
