import { describe, expect, test } from "bun:test";

import type { AiCellState } from "./ai-cell-state.logic";
import {
  AI_COLUMN_RUN_REVEAL,
  aiColumnRunMenu,
  aiColumnRunReveal,
  aiColumnRunScope,
} from "./ai-column-run.logic";
import type { AiColumnRunReveal } from "./ai-column-run.logic";

describe("AI column actions follow the visible cells", () => {
  test("a fresh page runs the column, a partial page runs holes or reruns, a completed page reruns", () => {
    expect(aiColumnRunMenu([{ type: "not_run" }])).toEqual([
      { type: "remaining", label: "aiColumns.runColumnPage" },
    ]);
    expect(aiColumnRunMenu([{ type: "done" }, { type: "not_run" }])).toEqual([
      { type: "remaining", label: "aiColumns.runRemainingPage" },
      { type: "rerun", label: "aiColumns.rerunAllPage" },
    ]);
    expect(aiColumnRunMenu([{ type: "done" }])).toEqual([
      { type: "rerun", label: "aiColumns.rerunColumnPage" },
    ]);
  });

  test("failed attempts offer rerun while budget refusals still offer the first run", () => {
    expect(aiColumnRunMenu([{ type: "failed" }])).toEqual([
      { type: "rerun", label: "aiColumns.rerunColumnPage" },
    ]);
    expect(aiColumnRunMenu([{ type: "refused_budget" }])).toEqual([
      { type: "remaining", label: "aiColumns.runColumnPage" },
    ]);
  });

  test("selection scopes the header run, a stale selection never targets unseen rows", () => {
    expect(
      aiColumnRunScope({ pageRowIds: ["a", "b", "c"], selectedRowIds: [] }),
    ).toEqual({ type: "page", rowIds: ["a", "b", "c"], count: 3 });
    expect(
      aiColumnRunScope({
        pageRowIds: ["a", "b", "c"],
        selectedRowIds: ["c", "a", "missing"],
      }),
    ).toEqual({ type: "selection", rowIds: ["a", "c"], count: 2 });
    expect(
      aiColumnRunScope({ pageRowIds: ["a"], selectedRowIds: ["missing"] }),
    ).toEqual({ type: "page", rowIds: ["a"], count: 1 });
  });
});

describe("the header Play stays on screen while it is the only sign of work", () => {
  const revealFor = {
    not_run: AI_COLUMN_RUN_REVEAL.pinned,
    queued: AI_COLUMN_RUN_REVEAL.pinned,
    running: AI_COLUMN_RUN_REVEAL.pinned,
    done: AI_COLUMN_RUN_REVEAL.onInteraction,
    not_stated: AI_COLUMN_RUN_REVEAL.onInteraction,
    failed: AI_COLUMN_RUN_REVEAL.onInteraction,
    refused: AI_COLUMN_RUN_REVEAL.onInteraction,
    refused_budget: AI_COLUMN_RUN_REVEAL.onInteraction,
  } as const satisfies Record<AiCellState["type"], AiColumnRunReveal>;
  const cellStates = [
    { type: "not_run" },
    { type: "queued" },
    { type: "running" },
    { type: "done" },
    { type: "not_stated" },
    { type: "failed" },
    { type: "refused", reason: "modelRefusal" },
    { type: "refused_budget" },
  ] as const satisfies readonly AiCellState[];

  test("rows that never ran or are in flight pin it; settled rows leave it to hover and focus", () => {
    for (const state of cellStates) {
      expect(aiColumnRunReveal({ states: [state], menuOpen: false })).toBe(
        revealFor[state.type],
      );
      // One pinning row among settled ones still pins the header.
      expect(
        aiColumnRunReveal({
          states: [{ type: "done" }, state, { type: "failed" }],
          menuOpen: false,
        }),
      ).toBe(revealFor[state.type]);
    }
    expect(aiColumnRunReveal({ states: [], menuOpen: false })).toBe(
      AI_COLUMN_RUN_REVEAL.onInteraction,
    );
  });

  test("an open column menu pins it whatever the rows show", () => {
    for (const state of cellStates) {
      expect(aiColumnRunReveal({ states: [state], menuOpen: true })).toBe(
        AI_COLUMN_RUN_REVEAL.pinned,
      );
    }
    expect(aiColumnRunReveal({ states: [], menuOpen: true })).toBe(
      AI_COLUMN_RUN_REVEAL.pinned,
    );
  });
});
