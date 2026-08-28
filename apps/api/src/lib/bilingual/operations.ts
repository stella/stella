// Headless edits that realise each row's disposition on a bilingual table.

import type { FolioAIEditOperation } from "@stll/folio-core/server";

import { BILINGUAL_ROW_DISPOSITION } from "@/api/lib/bilingual/contract";
import type {
  BilingualRowDisposition,
  BilingualRowStatus,
} from "@/api/lib/bilingual/contract";
import type { BilingualUnit } from "@/api/lib/bilingual/rows";

const INLINE_SEPARATOR = " / ";

export type StoredRow = BilingualUnit & {
  disposition: BilingualRowDisposition;
  targetText: string | null;
  status: BilingualRowStatus;
};

const isMergeDisposition = (disposition: BilingualRowDisposition): boolean =>
  disposition === BILINGUAL_ROW_DISPOSITION.KEEP ||
  disposition === BILINGUAL_ROW_DISPOSITION.INLINE;

/**
 * Headless edits that realise each row's disposition on the bilingual table.
 * Rows without a translation (failed batches) are left as the source copy,
 * never merged away: a missing translation must stay visible.
 */
export const buildOperations = (
  rows: readonly StoredRow[],
  translated: ReadonlyMap<string, string>,
): FolioAIEditOperation[] => {
  const operations: FolioAIEditOperation[] = [];
  let sequence = 0;
  const nextId = (): string => {
    sequence += 1;
    return `bilingual-${sequence}`;
  };
  for (const row of rows) {
    const text = translated.get(row.rowId);
    if (row.inTable) {
      if (
        row.disposition === BILINGUAL_ROW_DISPOSITION.KEEP ||
        text === undefined
      ) {
        continue;
      }
      operations.push({
        id: nextId(),
        type: "replaceBlock",
        blockId: row.rowId,
        text:
          row.disposition === BILINGUAL_ROW_DISPOSITION.INLINE
            ? `${row.sourceText}${INLINE_SEPARATOR}${text}`
            : text,
        preserveFormatting: true,
      });
      continue;
    }
    if (row.disposition === BILINGUAL_ROW_DISPOSITION.TRANSLATE) {
      if (text !== undefined) {
        operations.push({
          id: nextId(),
          type: "replaceBlock",
          blockId: row.rowId,
          text,
          preserveFormatting: true,
        });
      }
      continue;
    }
    if (!isMergeDisposition(row.disposition) || row.sourceParaId === null) {
      continue;
    }
    if (
      row.disposition === BILINGUAL_ROW_DISPOSITION.INLINE &&
      text === undefined
    ) {
      continue;
    }
    if (
      row.disposition === BILINGUAL_ROW_DISPOSITION.INLINE &&
      text !== undefined
    ) {
      operations.push({
        id: nextId(),
        type: "replaceBlock",
        blockId: row.sourceParaId,
        text: `${row.sourceText}${INLINE_SEPARATOR}${text}`,
        preserveFormatting: true,
      });
    }
    operations.push({
      id: nextId(),
      type: "mergeTableCells",
      blockId: row.sourceParaId,
      endBlockId: row.rowId,
    });
    operations.push({ id: nextId(), type: "deleteBlock", blockId: row.rowId });
  }
  return operations;
};

/**
 * Structural edits used after formatted translations have already been
 * written into cloned runs. Text edits are deliberately absent: a Folio
 * `replaceBlock` accepts plain text and cannot retain mixed run formatting.
 */
export const buildFormattingPreservingOperations = (
  rows: readonly StoredRow[],
  translatedRowIds: ReadonlySet<string>,
): FolioAIEditOperation[] => {
  const operations: FolioAIEditOperation[] = [];
  let sequence = 0;
  const nextId = (): string => {
    sequence += 1;
    return `bilingual-structure-${sequence}`;
  };
  for (const row of rows) {
    if (row.inTable || row.sourceParaId === null) {
      continue;
    }
    const shouldMerge =
      row.disposition === BILINGUAL_ROW_DISPOSITION.KEEP ||
      (row.disposition === BILINGUAL_ROW_DISPOSITION.INLINE &&
        translatedRowIds.has(row.rowId));
    if (!shouldMerge) {
      continue;
    }
    operations.push({
      id: nextId(),
      type: "mergeTableCells",
      blockId: row.sourceParaId,
      endBlockId: row.rowId,
    });
    operations.push({ id: nextId(), type: "deleteBlock", blockId: row.rowId });
  }
  return operations;
};
