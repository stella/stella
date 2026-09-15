import { describe, expect, test } from "bun:test";

import type { DocxEditorRef, FolioAIEditOperation } from "@stll/folio-react";

import { applyReviewChange } from "./review-change-apply.logic";
import type { ReviewChangeApplyEditor } from "./review-change-apply.logic";
import type { ReviewSuggestion } from "./review-store";

const snapshot = { anchors: {}, blocks: [] };
const UNDO = { id: "undo", type: "documentOperationUndo" } as const;

const deletion = (id: string, blockId: string): ReviewSuggestion => ({
  applyMode: null,
  area: "Profiling",
  blockId,
  id,
  origin: "chat",
  pendingOperation: { id: `op-${id}`, type: "deleteBlock", blockId },
  preview: { type: "deleteBlock", before: id },
  revisionIds: null,
  severity: "medium",
  snapshot,
  status: "applying",
  summary: `Delete ${id}`,
  type: "deleteBlock",
  undoHandle: null,
});

type ApplyOptions = Parameters<DocxEditorRef["applyDocumentOperations"]>[0];

/** An editor that applies the operations `lands` names and skips the rest. */
const fakeEditor = (lands: (operation: FolioAIEditOperation) => boolean) => {
  const batches: ApplyOptions[] = [];
  const undone: unknown[] = [];
  const editor: ReviewChangeApplyEditor = {
    applyDocumentOperations: (options) => {
      batches.push(options);
      const landed = options.batch.operations.filter(lands);
      return {
        applied: landed.map((operation, index) => ({
          id: operation.id,
          revisionIds: [index * 2 + 1, index * 2 + 2],
        })),
        skipped: options.batch.operations
          .filter((operation) => !lands(operation))
          .map((operation) => ({
            id: operation.id,
            reason: "changedBlock" as const,
          })),
        undoHandle: landed.length === 0 ? null : UNDO,
      };
    },
    createAIEditSnapshot: () => null,
    rejectAIEditOperation: () => true,
    undoDocumentOperations: (undoHandle) => {
      undone.push(undoHandle);
      return { status: "undone", undoHandle };
    },
  };
  return { editor, batches, undone };
};

describe("accepting a deletion run", () => {
  const heading = deletion("heading", "b13");
  const body = deletion("body", "b13-1");
  const bodyAgain = deletion("body-again", "b13-1");

  test("applies every distinct operation in one batch", () => {
    const { editor, batches } = fakeEditor(() => true);

    const outcomes = applyReviewChange({
      editor,
      members: [heading, body, bodyAgain],
      mode: "tracked-changes",
      author: "Jana Nováková",
    });

    expect(batches).toHaveLength(1);
    expect(batches.at(0)?.batch.atomic).toBe(true);
    expect(
      batches.at(0)?.batch.operations.map((operation) => operation.id),
    ).toEqual(["op-heading", "op-body"]);
    expect(
      outcomes.map(({ member, outcome }) => [
        member.id,
        outcome.status,
        outcome.revisionIds,
        outcome.undoHandle,
      ]),
    ).toEqual([
      ["heading", "accepted", [1, 2], UNDO],
      ["body", "accepted", [3, 4], UNDO],
      ["body-again", "accepted", [3, 4], UNDO],
    ]);
  });

  test("accepts nothing when the batch lands only part of the run", () => {
    const { editor, undone } = fakeEditor(
      (operation) => operation.id === "op-heading",
    );

    const outcomes = applyReviewChange({
      editor,
      members: [heading, body],
      mode: "tracked-changes",
      author: "",
    });

    expect(undone).toEqual([UNDO]);
    expect(
      outcomes.map(({ outcome }) => [
        outcome.status,
        outcome.skipReason,
        outcome.revisionIds,
        outcome.undoHandle,
      ]),
    ).toEqual([
      ["skipped", "changedBlock", null, null],
      ["skipped", "changedBlock", null, null],
    ]);
  });
});
