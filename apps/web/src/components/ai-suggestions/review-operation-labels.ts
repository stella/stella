/**
 * What one proposed edit says, before it is put into words.
 *
 * Two readings of the same operation, because a reviewer asks two different
 * questions about it. `describeOperationSummary` answers "what kind of change,
 * and where" — the card's title. `describeSuggestionChange` answers "what
 * would land in the document" — the line under the floating bar's label, where
 * the reviewer is about to press Accept and needs the wording, not the verb.
 *
 * Both return keys rather than sentences: the decision is made here, where it
 * is testable without a locale, and rendered where one is available.
 *
 * A folio block id is a storage handle ("67D3C23F"), never a place a reader
 * knows. The clause label the AI saw ("2.1") is the only address that means
 * anything, and where a block has none the summary says the kind of change and
 * stops. No branch here may put an id into a sentence.
 */

import { panic } from "better-result";

import type { FolioAIEditOperation } from "@stll/folio-react";

import type { TranslationKey } from "@/i18n/types";

/**
 * ICU `select` branch for a block with no clause label. A document whose
 * clause is literally numbered "none" would read as unlabelled, which is the
 * harmless direction to be wrong in.
 */
const NO_LABEL = "none";

/** How much of each side of a replacement the bar shows before eliding. */
export const CHANGE_PHRASE_CHARS = 40;
/** How much of a whole new paragraph the bar shows before eliding. */
export const CHANGE_TEXT_CHARS = 60;

const ELLIPSIS = "…";

const SUMMARY_KEYS = {
  replaceInBlock: "docxReview.summary.replaceInBlock",
  replaceParagraph: "docxReview.summary.replaceParagraph",
  insertAfter: "docxReview.summary.insertAfter",
  insertBefore: "docxReview.summary.insertBefore",
  pageBreakAfter: "docxReview.summary.pageBreakAfter",
  pageBreakBefore: "docxReview.summary.pageBreakBefore",
  deleteParagraph: "docxReview.summary.deleteParagraph",
  splitParagraph: "docxReview.summary.splitParagraph",
  mergeParagraphs: "docxReview.summary.mergeParagraphs",
  formatParagraph: "docxReview.summary.formatParagraph",
  commentOnParagraph: "docxReview.summary.commentOnParagraph",
  insertSignatureBlock: "docxReview.summary.insertSignatureBlock",
  insertTable: "docxReview.summary.insertTable",
  deleteTable: "docxReview.summary.deleteTable",
  insertTableRow: "docxReview.summary.insertTableRow",
  deleteTableRow: "docxReview.summary.deleteTableRow",
  insertTableColumn: "docxReview.summary.insertTableColumn",
  deleteTableColumn: "docxReview.summary.deleteTableColumn",
  mergeTableCells: "docxReview.summary.mergeTableCells",
  splitTableCell: "docxReview.summary.splitTableCell",
  replaceSelection: "docxReview.summary.replaceSelection",
  commentOnSelection: "docxReview.summary.commentOnSelection",
  formatSelection: "docxReview.summary.formatSelection",
} as const satisfies Record<string, TranslationKey>;

/** Wording for the change line, which states the action on its own and so
 *  cannot reuse a summary key that names a clause. */
const CHANGE_KEYS = {
  deleteParagraph: "docxReview.change.deleteParagraph",
} as const satisfies Record<string, TranslationKey>;

/** A summary line, ready for `t(key, values)`. */
export type OperationSummaryMessage = {
  key: (typeof SUMMARY_KEYS)[keyof typeof SUMMARY_KEYS];
  values: Record<string, string>;
};

/**
 * Collapse a run of document text to one line the width of a control.
 *
 * Word wrap and tabs inside a DOCX paragraph are layout, not wording, so they
 * flatten to single spaces before the measure is taken.
 */
export const condenseChangeText = (text: string, limit: number): string => {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length <= limit
    ? flat
    : `${flat.slice(0, limit).trimEnd()}${ELLIPSIS}`;
};

const labelValue = (blockLabel: string | undefined): string => {
  const trimmed = blockLabel?.trim() ?? "";
  return trimmed.length === 0 ? NO_LABEL : trimmed;
};

/**
 * The card title for one operation: the kind of change, and the clause it
 * lands on when the document names one.
 *
 * `blockLabel` is the display label from the snapshot the AI saw (e.g. "2.1",
 * "čl. 7"). Never a block id — see the module note.
 */
export const describeOperationSummary = (
  operation: FolioAIEditOperation,
  blockLabel?: string,
): OperationSummaryMessage => {
  const label = labelValue(blockLabel);
  switch (operation.type) {
    case "replaceInBlock":
      return {
        key: SUMMARY_KEYS.replaceInBlock,
        values: {
          find: condenseChangeText(operation.find, CHANGE_PHRASE_CHARS),
          replace: condenseChangeText(operation.replace, CHANGE_PHRASE_CHARS),
        },
      };
    case "replaceBlock":
      return { key: SUMMARY_KEYS.replaceParagraph, values: { label } };
    case "insertAfterBlock":
    case "insertBeforeBlock": {
      const isPageBreak =
        operation.pageBreakBefore === true && operation.text.length === 0;
      const after = operation.type === "insertAfterBlock";
      if (isPageBreak) {
        return {
          key: after
            ? SUMMARY_KEYS.pageBreakAfter
            : SUMMARY_KEYS.pageBreakBefore,
          values: { label },
        };
      }
      return {
        key: after ? SUMMARY_KEYS.insertAfter : SUMMARY_KEYS.insertBefore,
        values: { label },
      };
    }
    case "deleteBlock":
      return { key: SUMMARY_KEYS.deleteParagraph, values: { label } };
    case "splitBlock":
      return { key: SUMMARY_KEYS.splitParagraph, values: { label } };
    case "mergeBlockWithNext":
      return { key: SUMMARY_KEYS.mergeParagraphs, values: { label } };
    // A style or a list level, never words: "reformat" is the same verb the
    // inline formatting change uses, at paragraph scope.
    case "setBlockParagraphProperties":
      return { key: SUMMARY_KEYS.formatParagraph, values: { label } };
    case "commentOnBlock":
      return { key: SUMMARY_KEYS.commentOnParagraph, values: { label } };
    case "insertSignatureTable":
      return {
        key: SUMMARY_KEYS.insertSignatureBlock,
        values: {
          names: operation.parties
            .flatMap((party) => (party.name.length > 0 ? [party.name] : []))
            .join(", "),
        },
      };
    case "insertTable":
      return { key: SUMMARY_KEYS.insertTable, values: {} };
    case "deleteTable":
      return { key: SUMMARY_KEYS.deleteTable, values: {} };
    case "insertTableRow":
      return { key: SUMMARY_KEYS.insertTableRow, values: {} };
    case "deleteTableRow":
      return { key: SUMMARY_KEYS.deleteTableRow, values: {} };
    case "insertTableColumn":
      return { key: SUMMARY_KEYS.insertTableColumn, values: {} };
    case "deleteTableColumn":
      return { key: SUMMARY_KEYS.deleteTableColumn, values: {} };
    case "mergeTableCells":
      return { key: SUMMARY_KEYS.mergeTableCells, values: {} };
    case "splitTableCell":
      return { key: SUMMARY_KEYS.splitTableCell, values: {} };
    case "replaceRange":
      return {
        key: SUMMARY_KEYS.replaceSelection,
        values: {
          replace: condenseChangeText(operation.replace, CHANGE_PHRASE_CHARS),
        },
      };
    case "commentOnRange":
      return { key: SUMMARY_KEYS.commentOnSelection, values: {} };
    case "formatRange":
      return { key: SUMMARY_KEYS.formatSelection, values: {} };
    default:
      operation satisfies never;
      return panic(`Unhandled operation: ${String(operation)}`);
  }
};

/**
 * The wording an accept would put in the document, compact enough for one line
 * under the bar's label.
 *
 * `null` where the operation has no wording to show (structural table edits,
 * a formatting change): the summary line above already names those in full,
 * and a second line repeating it would be noise.
 */
export type SuggestionChange =
  | { type: "replacement"; find: string; replace: string }
  | { type: "text"; text: string }
  | { type: "message"; key: (typeof CHANGE_KEYS)[keyof typeof CHANGE_KEYS] }
  | null;

export const describeSuggestionChange = (
  operation: FolioAIEditOperation,
): SuggestionChange => {
  switch (operation.type) {
    case "replaceInBlock":
      return {
        type: "replacement",
        find: condenseChangeText(operation.find, CHANGE_PHRASE_CHARS),
        replace: condenseChangeText(operation.replace, CHANGE_PHRASE_CHARS),
      };
    case "replaceBlock":
    case "insertAfterBlock":
    case "insertBeforeBlock": {
      const text = condenseChangeText(operation.text, CHANGE_TEXT_CHARS);
      return text.length === 0 ? null : { type: "text", text };
    }
    case "replaceRange": {
      const text = condenseChangeText(operation.replace, CHANGE_TEXT_CHARS);
      return text.length === 0 ? null : { type: "text", text };
    }
    case "deleteBlock":
      return { type: "message", key: CHANGE_KEYS.deleteParagraph };
    case "commentOnBlock":
    case "commentOnRange": {
      const text = condenseChangeText(
        operation.comment.text,
        CHANGE_TEXT_CHARS,
      );
      return text.length === 0 ? null : { type: "text", text };
    }
    case "insertSignatureTable": {
      const names = operation.parties
        .flatMap((party) => (party.name.length > 0 ? [party.name] : []))
        .join(", ");
      const text = condenseChangeText(names, CHANGE_TEXT_CHARS);
      return text.length === 0 ? null : { type: "text", text };
    }
    // Nothing to quote under the label. A structural edit is named in full by
    // the summary line above, and the wording it would put in the document is
    // either nothing (a break, a table removed, a restyled paragraph) or a
    // grid the one-line bar cannot show (an inserted table's cells).
    case "splitBlock":
    case "mergeBlockWithNext":
    case "setBlockParagraphProperties":
    case "insertTable":
    case "deleteTable":
    case "insertTableRow":
    case "deleteTableRow":
    case "insertTableColumn":
    case "deleteTableColumn":
    case "mergeTableCells":
    case "splitTableCell":
    case "formatRange":
      return null;
    default:
      operation satisfies never;
      return panic(`Unhandled operation: ${String(operation)}`);
  }
};
