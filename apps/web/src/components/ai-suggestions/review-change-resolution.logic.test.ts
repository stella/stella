import { describe, expect, test } from "bun:test";

import type { DocxResolveResult } from "./docx-suggestion-persistence";
import type { ReviewChangeUndoEditor } from "./review-change-apply.logic";
import { replayResolvedSuggestions } from "./review-change-resolution.logic";
import type { ReplayRow } from "./review-change-resolution.logic";
import type { ReviewSuggestion } from "./review-store";

const ACCEPT_BATCH = { id: "undo-1", type: "documentOperationUndo" } as const;
const OTHER_ACCEPT_BATCH = {
  id: "undo-2",
  type: "documentOperationUndo",
} as const;

const acceptedDeletion = (
  id: string,
  undoHandle: ReviewSuggestion["undoHandle"],
): ReplayRow => ({
  applyMode: "direct",
  area: "Profiling",
  blockId: `block-${id}`,
  id,
  origin: "chat",
  pendingOperation: { id: `op-${id}`, type: "deleteBlock", blockId: id },
  persisted: true,
  preview: { type: "deleteBlock", before: id },
  proposalBatchId: "proposal-1",
  revisionIds: null,
  severity: "medium",
  snapshot: null,
  status: "accepted",
  summary: `Delete ${id}`,
  type: "deleteBlock",
  undoHandle,
});

type ReplayHarnessOptions = {
  rows: readonly ReplayRow[];
  resolveResults: Record<string, DocxResolveResult>;
};

const replayHarness = ({ rows, resolveResults }: ReplayHarnessOptions) => {
  const session = new Map<string, ReviewSuggestion>(
    rows.map((row) => [row.id, row]),
  );
  const undone: unknown[] = [];
  const reverted: string[] = [];
  const editor: ReviewChangeUndoEditor = {
    rejectAIEditOperation: () => true,
    undoDocumentOperations: (undoHandle) => {
      undone.push(undoHandle);
      return { status: "undone", undoHandle };
    },
  };
  const replay = async () =>
    await replayResolvedSuggestions({
      rows,
      readEditor: () => editor,
      resolve: async (row) =>
        await Promise.resolve(resolveResults[row.id] ?? "synced"),
      revert: async (row) => {
        reverted.push(row.id);
        return await Promise.resolve("synced" as const);
      },
      run: async (_row, write) => await write(),
      readLive: (id) => session.get(id),
      updateSuggestion: (id, patch) => {
        const row = session.get(id);
        if (row !== undefined) {
          session.set(id, { ...row, ...patch });
        }
      },
    });
  const statusOf = (id: string) => session.get(id)?.status;
  return { replay, undone, reverted, statusOf };
};

describe("replaying resolutions made before the rows were persisted", () => {
  test("a failed member takes its whole accept batch back", async () => {
    const harness = replayHarness({
      rows: [
        acceptedDeletion("heading", ACCEPT_BATCH),
        acceptedDeletion("body", ACCEPT_BATCH),
      ],
      resolveResults: { body: "failed" },
    });

    const results = await harness.replay();

    expect(results).toContain("failed");
    expect(harness.undone).toEqual([ACCEPT_BATCH]);
    expect(harness.statusOf("heading")).toBe("pending");
    expect(harness.statusOf("body")).toBe("pending");
    expect(harness.reverted).toEqual(["heading"]);
  });

  test("a separate accept batch keeps its resolution", async () => {
    const harness = replayHarness({
      rows: [
        acceptedDeletion("heading", ACCEPT_BATCH),
        acceptedDeletion("body", ACCEPT_BATCH),
        acceptedDeletion("later", OTHER_ACCEPT_BATCH),
      ],
      resolveResults: { body: "failed" },
    });

    await harness.replay();

    expect(harness.statusOf("later")).toBe("accepted");
    expect(harness.undone).toEqual([ACCEPT_BATCH]);
    expect(harness.reverted).toEqual(["heading"]);
  });

  test("a member resolved elsewhere leaves its batch standing", async () => {
    const harness = replayHarness({
      rows: [
        acceptedDeletion("heading", ACCEPT_BATCH),
        acceptedDeletion("body", ACCEPT_BATCH),
      ],
      resolveResults: { body: "stale" },
    });

    await harness.replay();

    expect(harness.undone).toEqual([]);
    expect(harness.statusOf("heading")).toBe("accepted");
    expect(harness.statusOf("body")).toBe("accepted");
    expect(harness.reverted).toEqual([]);
  });
});
