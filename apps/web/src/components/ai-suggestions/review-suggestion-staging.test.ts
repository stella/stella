import { describe, expect, mock, test } from "bun:test";

import type { ReviewSuggestion } from "./review-store";
import { stageReviewSuggestions } from "./review-suggestion-staging";

const snapshot = { anchors: {}, blocks: [] };
const suggestion = (id: string): ReviewSuggestion => ({
  applyMode: null,
  area: "Parties",
  blockId: "party",
  id,
  pendingOperation: {
    blockId: "party",
    id,
    text: "Martina Novotna",
    type: "replaceBlock",
  },
  preview: {
    after: "Martina Novotna",
    before: "Second party",
    type: "replaceBlock",
  },
  revisionIds: null,
  severity: "medium",
  snapshot,
  status: "pending",
  summary: "Replace party",
  type: "replaceBlock",
  undoHandle: null,
});

describe("native review suggestion staging", () => {
  test("uses Folio suggested mode so a whole-block preview participates in layout", () => {
    const applyDocumentOperations = mock(() => ({
      applied: [
        {
          id: "proposal-1",
          revisionId: 7,
          revisionIds: [7, 8],
          suggestionId: "proposal-1",
        },
      ],
      skipped: [],
      undoHandle: { id: "undo", type: "documentOperationUndo" as const },
    }));
    const updateSuggestion = mock(() => undefined);
    const editor = {
      applyDocumentOperations,
      getSuggestions: () => [],
    };

    stageReviewSuggestions({
      editor,
      suggestions: [suggestion("proposal-1")],
      updateSuggestion,
    });

    expect(applyDocumentOperations).toHaveBeenCalledWith({
      snapshot,
      batch: {
        version: 1,
        mode: "suggested",
        operations: [
          expect.objectContaining({
            id: "proposal-1",
            suggestionId: "proposal-1",
          }),
        ],
      },
    });
    expect(updateSuggestion).toHaveBeenCalledWith("proposal-1", {
      revisionIds: [7, 8],
      undoHandle: { id: "undo", type: "documentOperationUndo" },
    });
  });

  test("never stages an operation Folio already owns", () => {
    const applyDocumentOperations = mock(() => {
      throw new Error("must not apply twice");
    });
    const editor = {
      applyDocumentOperations,
      getSuggestions: () => [
        {
          appliedAs: "tracked" as const,
          kinds: ["insertion" as const],
          ranges: [{ from: 1, to: 2 }],
          suggestionId: "proposal-1",
        },
      ],
    };

    stageReviewSuggestions({
      editor,
      suggestions: [suggestion("proposal-1")],
      updateSuggestion: () => undefined,
    });

    expect(applyDocumentOperations).not.toHaveBeenCalled();
  });
});
