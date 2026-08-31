import { describe, expect, mock, test } from "bun:test";

import type { ReviewSuggestion } from "./review-store";
import { stageReviewSuggestions } from "./review-suggestion-staging";

const snapshot = { anchors: {}, blocks: [] };
const suggestion = (id: string): ReviewSuggestion => ({
  applyMode: null,
  area: "Parties",
  blockId: "party",
  id,
  origin: "chat",
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
      rejectSuggestion: () => false,
    };

    stageReviewSuggestions({
      canStage: true,
      editor,
      managedSuggestionIds: new Set(),
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
      rejectSuggestion: () => false,
    };

    stageReviewSuggestions({
      canStage: true,
      editor,
      managedSuggestionIds: new Set(),
      suggestions: [suggestion("proposal-1")],
      updateSuggestion: () => undefined,
    });

    expect(applyDocumentOperations).not.toHaveBeenCalled();
  });

  test("removes managed Folio suggestions when the review session resets", () => {
    const liveSuggestionIds = new Set<string>();
    const applyDocumentOperations = mock((options) => {
      const operation = options.batch.operations.at(0);
      if (operation?.suggestionId !== undefined) {
        liveSuggestionIds.add(operation.suggestionId);
      }
      return {
        applied: [
          {
            id: "proposal-1",
            revisionIds: [7, 8],
            suggestionId: "proposal-1",
          },
        ],
        skipped: [],
        undoHandle: { id: "undo", type: "documentOperationUndo" as const },
      };
    });
    const rejectSuggestion = mock((suggestionId: string) =>
      liveSuggestionIds.delete(suggestionId),
    );
    const editor = {
      applyDocumentOperations,
      getSuggestions: () =>
        [...liveSuggestionIds].map((suggestionId) => ({
          appliedAs: "tracked" as const,
          kinds: ["insertion" as const],
          ranges: [{ from: 1, to: 2 }],
          suggestionId,
        })),
      rejectSuggestion,
    };
    const managedSuggestionIds = new Set<string>();

    stageReviewSuggestions({
      canStage: true,
      editor,
      managedSuggestionIds,
      suggestions: [suggestion("proposal-1")],
      updateSuggestion: () => undefined,
    });
    expect(managedSuggestionIds).toEqual(new Set(["proposal-1"]));
    liveSuggestionIds.add("user-change");

    stageReviewSuggestions({
      canStage: false,
      editor,
      managedSuggestionIds,
      suggestions: [],
      updateSuggestion: () => undefined,
    });

    expect(rejectSuggestion).toHaveBeenCalledWith("proposal-1");
    expect(rejectSuggestion).not.toHaveBeenCalledWith("user-change");
    expect(liveSuggestionIds).toEqual(new Set(["user-change"]));
    expect(managedSuggestionIds).toEqual(new Set());
  });
});
