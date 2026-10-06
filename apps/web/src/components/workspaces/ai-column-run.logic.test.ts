import { describe, expect, test } from "bun:test";

import { aiColumnRunMenu, aiColumnRunScope } from "./ai-column-run.logic";

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
