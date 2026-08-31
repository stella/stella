import { describe, expect, test } from "bun:test";

import { createFolioAIEditSnapshot } from "@stll/folio-core/ai-edits";
import { schema } from "@stll/folio-core/prosemirror";

import {
  buildFolioReviewDecorations,
  resolveFolioReviewFocusId,
} from "./review-folio-decorations";
import type { ReviewSuggestion } from "./review-store";

const doc = schema.node("doc", undefined, [
  schema.node("paragraph", { paraId: "A1" }, [
    schema.text("Pay within 30 days."),
  ]),
]);
const snapshot = createFolioAIEditSnapshot(doc);

const suggestion = (
  patch: Partial<ReviewSuggestion> = {},
): ReviewSuggestion => ({
  applyMode: null,
  area: "Payment",
  blockId: "A1",
  id: "suggestion-1",
  origin: "chat",
  pendingOperation: {
    blockId: "A1",
    find: "30 days",
    id: "suggestion-1",
    replace: "45 days",
    type: "replaceInBlock",
  },
  preview: {
    after: "45 days",
    before: "30 days",
    contextAfter: ".",
    contextBefore: "Pay within ",
    type: "replaceInBlock",
  },
  revisionIds: null,
  severity: "high",
  snapshot,
  status: "pending",
  summary: "Extend the payment period",
  type: "replaceInBlock",
  undoHandle: null,
  ...patch,
});

describe("buildFolioReviewDecorations", () => {
  test("shows the exact original and replacement for pending text edits", () => {
    expect(buildFolioReviewDecorations([suggestion()], doc)).toEqual([
      expect.objectContaining({
        id: "suggestion-1",
        originalText: "30 days",
        range: { from: 12, to: 19 },
        severity: "substantive",
        suggestedText: "45 days",
      }),
    ]);
  });

  test("omits resolved and structurally unrepresentable operations", () => {
    expect(
      buildFolioReviewDecorations(
        [
          suggestion({ status: "accepted" }),
          suggestion({
            pendingOperation: {
              blockId: "A1",
              id: "insert-1",
              text: "New paragraph",
              type: "insertAfterBlock",
            },
          }),
        ],
        doc,
      ),
    ).toEqual([]);
  });

  test("reduces a block rewrite to its changed span instead of overflowing the page", () => {
    const longDoc = schema.node("doc", undefined, [
      schema.node("paragraph", { paraId: "A1" }, [
        schema.text(
          "The first party is [name], residing at [address], and represented by [representative].",
        ),
      ]),
    ]);
    const longSnapshot = createFolioAIEditSnapshot(longDoc);

    expect(
      buildFolioReviewDecorations(
        [
          suggestion({
            pendingOperation: {
              blockId: "A1",
              id: "suggestion-1",
              text: "The first party is Jan Novak, residing at [address], and represented by [representative].",
              type: "replaceBlock",
            },
            preview: {
              after:
                "The first party is Jan Novak, residing at [address], and represented by [representative].",
              before:
                "The first party is [name], residing at [address], and represented by [representative].",
              type: "replaceBlock",
            },
            snapshot: longSnapshot,
            type: "replaceBlock",
          }),
        ],
        longDoc,
      ),
    ).toEqual([
      expect.objectContaining({
        originalText: "[name]",
        range: { from: 20, to: 26 },
        suggestedText: "Jan Novak",
      }),
    ]);
  });

  test("keeps pure block insertions out of Folio's range-only preview", () => {
    expect(
      buildFolioReviewDecorations(
        [
          suggestion({
            pendingOperation: {
              blockId: "A1",
              id: "suggestion-1",
              text: "Pay promptly within 30 days.",
              type: "replaceBlock",
            },
            preview: {
              after: "Pay promptly within 30 days.",
              before: "Pay within 30 days.",
              type: "replaceBlock",
            },
            type: "replaceBlock",
          }),
        ],
        doc,
      ),
    ).toEqual([]);
  });

  test("keeps whole-paragraph rewrites out of Folio's non-reflowing overlay", () => {
    expect(
      buildFolioReviewDecorations(
        [
          suggestion({
            pendingOperation: {
              blockId: "A1",
              id: "suggestion-1",
              text: "Martina Novotna, residing at Techlovice 113, 503 27 Techlovice, company number 00750883.",
              type: "replaceBlock",
            },
            preview: {
              after:
                "Martina Novotna, residing at Techlovice 113, 503 27 Techlovice, company number 00750883.",
              before: "Pay within 30 days.",
              type: "replaceBlock",
            },
            type: "replaceBlock",
          }),
        ],
        doc,
      ),
    ).toEqual([]);
  });
});

describe("resolveFolioReviewFocusId", () => {
  test("uses the stable operation id after server reconciliation staged a native suggestion", () => {
    const reconciled = suggestion({
      id: "server-suggestion-id",
      pendingOperation: {
        blockId: "A1",
        find: "30 days",
        id: "client-operation-id",
        replace: "45 days",
        type: "replaceInBlock",
      },
      persisted: true,
    });

    expect(
      resolveFolioReviewFocusId({
        focusedId: "server-suggestion-id",
        nativeSuggestionIds: new Set(["client-operation-id"]),
        suggestions: [reconciled],
      }),
    ).toBe("client-operation-id");
  });

  test("keeps the row id when the visible fallback decoration owns it", () => {
    const reconciled = suggestion({
      id: "server-suggestion-id",
      pendingOperation: {
        blockId: "A1",
        find: "30 days",
        id: "client-operation-id",
        replace: "45 days",
        type: "replaceInBlock",
      },
      persisted: true,
    });

    expect(
      resolveFolioReviewFocusId({
        focusedId: "server-suggestion-id",
        nativeSuggestionIds: new Set(),
        suggestions: [reconciled],
      }),
    ).toBe("server-suggestion-id");
  });
});
