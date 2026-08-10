import { describe, expect, test } from "bun:test";

import {
  getTaskDetailInstanceKey,
  getTaskStatusUpdate,
} from "./task-detail-panel.logic";

describe("task detail compatibility updates", () => {
  test("includes a trimmed workflow reason only when cancelling", () => {
    expect(
      getTaskStatusUpdate("task-1", "cancelled", "  No longer needed  "),
    ).toEqual({
      taskId: "task-1",
      status: "cancelled",
      workflowReason: "No longer needed",
    });
    expect(
      getTaskStatusUpdate("task-1", "in_review", "Keep this draft"),
    ).toEqual({ taskId: "task-1", status: "in_review" });
  });
});

describe("task detail local state scope", () => {
  test("changes the component instance key when the task changes", () => {
    expect(
      getTaskDetailInstanceKey({ workspaceId: "workspace-1", taskId: "a" }),
    ).not.toBe(
      getTaskDetailInstanceKey({ workspaceId: "workspace-1", taskId: "b" }),
    );
  });
});
