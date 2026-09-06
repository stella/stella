import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import { FOLIO_DOCUMENT_OPERATION_TYPES } from "@stll/folio-core";
import type { FolioAIEditOperation } from "@stll/folio-react";

import en from "@/i18n/langs/en.json";

import {
  CHANGE_PHRASE_CHARS,
  CHANGE_TEXT_CHARS,
  condenseChangeText,
  describeOperationSummary,
  describeSuggestionChange,
} from "./review-operation-labels";

/**
 * The same catalog `getTranslator()` boots with, wired up locally so the test
 * renders real sentences without pulling in the locale store's persistence.
 */
const t = createTranslator({ locale: "en", messages: en });

const render = (
  operation: FolioAIEditOperation,
  blockLabel?: string,
): string => {
  const { key, values } = describeOperationSummary(operation, blockLabel);
  return t(key, values);
};

/** A folio block handle, in the shape the reader must never be shown. */
const BLOCK_ID = "67D3C23F";
const SEQUENTIAL_BLOCK_ID = "seq-0042";

const range = (blockId: string) =>
  ({
    type: "textRange",
    story: "main",
    blockId,
    startOffset: 0,
    endOffset: 4,
    selectedTextHash: "hash",
  }) as const;

/** Every operation the review surface can stage, one of each shape. */
const OPERATIONS: readonly FolioAIEditOperation[] = [
  {
    id: "1",
    type: "replaceInBlock",
    blockId: BLOCK_ID,
    find: "30 days",
    replace: "45 days",
  },
  { id: "2", type: "replaceBlock", blockId: BLOCK_ID, text: "New wording." },
  {
    id: "3",
    type: "insertAfterBlock",
    blockId: BLOCK_ID,
    text: "Added clause.",
  },
  {
    id: "4",
    type: "insertBeforeBlock",
    blockId: SEQUENTIAL_BLOCK_ID,
    text: "Added clause.",
  },
  {
    id: "5",
    type: "insertAfterBlock",
    blockId: BLOCK_ID,
    text: "",
    pageBreakBefore: true,
  },
  { id: "6", type: "deleteBlock", blockId: BLOCK_ID },
  {
    id: "7",
    type: "commentOnBlock",
    blockId: SEQUENTIAL_BLOCK_ID,
    comment: { text: "Check this." },
  },
  {
    id: "8",
    type: "insertSignatureTable",
    blockId: BLOCK_ID,
    parties: [{ name: "Novák a spol." }, { name: "Stavby Morava" }],
  },
  { id: "9", type: "insertTableRow", blockId: BLOCK_ID },
  { id: "10", type: "deleteTableRow", blockId: BLOCK_ID },
  { id: "11", type: "insertTableColumn", blockId: BLOCK_ID },
  { id: "12", type: "deleteTableColumn", blockId: BLOCK_ID },
  { id: "13", type: "mergeTableCells", blockId: BLOCK_ID, rowCount: 2 },
  { id: "14", type: "splitTableCell", blockId: BLOCK_ID },
  { id: "15", type: "replaceRange", range: range(BLOCK_ID), replace: "soft" },
  {
    id: "16",
    type: "commentOnRange",
    range: range(SEQUENTIAL_BLOCK_ID),
    comment: { text: "Why hard?" },
  },
  {
    id: "17",
    type: "formatRange",
    range: range(BLOCK_ID),
    formatting: { bold: true },
  },
  { id: "18", type: "splitBlock", blockId: BLOCK_ID, offset: 5 },
  { id: "19", type: "mergeBlockWithNext", blockId: BLOCK_ID },
  {
    id: "20",
    type: "setBlockParagraphProperties",
    blockId: BLOCK_ID,
    properties: { listLevel: 1 },
  },
  {
    id: "21",
    type: "insertTable",
    blockId: BLOCK_ID,
    rows: [["Milestone", "Fee"]],
  },
  { id: "22", type: "deleteTable", blockId: BLOCK_ID },
];

// A folio block handle is 8 hex characters, or `seq-NNNN` for a positional id.
const BLOCK_ID_PATTERN = /\b(?:[0-9A-F]{8}|seq-\d{2,})\b/u;

describe("operation summaries", () => {
  test("covers every operation folio's contract declares", () => {
    // The fixture above mirrors folio's operation union, and a mirror kept by
    // hand drifts: a release that adds an operation must fail here rather
    // than leave the new summary untested.
    const staged = new Set(OPERATIONS.map((operation) => operation.type));
    const missing = FOLIO_DOCUMENT_OPERATION_TYPES.filter(
      (type) => !staged.has(type),
    );
    expect(missing).toEqual([]);
  });

  test("never put a block id in front of the reader", () => {
    for (const operation of OPERATIONS) {
      expect(render(operation)).not.toMatch(BLOCK_ID_PATTERN);
      expect(render(operation, "2.1")).not.toMatch(BLOCK_ID_PATTERN);
    }
  });

  test("name the clause when the document numbers it, and the change alone when it does not", () => {
    const deleteOp = OPERATIONS[5];
    const insertOp = OPERATIONS[2];
    if (deleteOp === undefined || insertOp === undefined) {
      throw new Error("Expected the fixture operations");
    }

    expect(render(deleteOp, "2.1")).toBe("Delete paragraph 2.1");
    expect(render(deleteOp)).toBe("Delete a paragraph");
    expect(render(deleteOp, "   ")).toBe("Delete a paragraph");
    expect(render(insertOp, "čl. 7")).toBe("Insert a paragraph after čl. 7");
  });

  test("quote the wording a find-and-replace would change", () => {
    const replaceInBlock = OPERATIONS[0];
    if (replaceInBlock === undefined) {
      throw new Error("Expected the fixture operation");
    }
    expect(render(replaceInBlock, "2.1")).toBe(
      "Replace “30 days” with “45 days”",
    );
  });
});

describe("change descriptions", () => {
  test("show both sides of a phrase replacement", () => {
    expect(
      describeSuggestionChange({
        id: "1",
        type: "replaceInBlock",
        blockId: BLOCK_ID,
        find: "30 days",
        replace: "45 days",
      }),
    ).toEqual({ type: "replacement", find: "30 days", replace: "45 days" });
  });

  test("show the opening of new wording for a rewrite or an insert", () => {
    const text = `${"word ".repeat(40)}end`;
    const rewrite = describeSuggestionChange({
      id: "2",
      type: "replaceBlock",
      blockId: BLOCK_ID,
      text,
    });
    const inserted = describeSuggestionChange({
      id: "3",
      type: "insertAfterBlock",
      blockId: BLOCK_ID,
      text,
    });

    expect(rewrite).toEqual(inserted);
    if (rewrite?.type !== "text") {
      throw new Error("Expected a text change");
    }
    expect(rewrite.text.endsWith("…")).toBe(true);
    expect(rewrite.text.length).toBeLessThanOrEqual(CHANGE_TEXT_CHARS + 1);
  });

  test("say a deletion in words, since it has no new wording to show", () => {
    expect(
      describeSuggestionChange({
        id: "6",
        type: "deleteBlock",
        blockId: BLOCK_ID,
      }),
    ).toEqual({ type: "message", key: "docxReview.change.deleteParagraph" });
  });

  test("stay silent for structural edits the summary already names", () => {
    expect(
      describeSuggestionChange({
        id: "9",
        type: "insertTableRow",
        blockId: BLOCK_ID,
      }),
    ).toBeNull();
  });
});

describe("condensing document text", () => {
  test("flattens wrapped paragraph text to one line", () => {
    expect(condenseChangeText("  a\n\tb   c  ", 40)).toBe("a b c");
  });

  test("elides past the limit without leaving a trailing space", () => {
    expect(
      condenseChangeText(`${"a".repeat(39)} bbbb`, CHANGE_PHRASE_CHARS),
    ).toBe(`${"a".repeat(39)}…`);
  });
});
