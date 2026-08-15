import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";

import {
  getTaskDetailInstanceKey,
  getTaskStatusUpdate,
  taskUpdateBody,
  workflowUpdateBody,
} from "./task-detail-panel.logic";

describe("task detail compatibility updates", () => {
  test("includes a trimmed workflow reason only when cancelling", () => {
    expect(
      getTaskStatusUpdate("task-1", "cancelled", "  No longer needed  "),
    ).toEqual({
      taskId: "task-1",
      type: "status",
      value: {
        status: "cancelled",
        workflowReason: "No longer needed",
      },
    });
    expect(
      getTaskStatusUpdate("task-1", "in_review", "Keep this draft"),
    ).toEqual({
      taskId: "task-1",
      type: "status",
      value: { status: "in_review" },
    });
  });

  test("maps every task command to one API update", () => {
    expect([
      taskUpdateBody({ taskId: "task-1", type: "name", value: "Review" }),
      taskUpdateBody({ taskId: "task-1", type: "priority", value: "high" }),
      taskUpdateBody({ taskId: "task-1", type: "dueDate", value: null }),
      taskUpdateBody({
        taskId: "task-1",
        type: "listItemType",
        value: "task",
      }),
      taskUpdateBody({
        taskId: "task-1",
        type: "status",
        value: { status: "cancelled", workflowReason: "Superseded" },
      }),
    ]).toEqual([
      { name: "Review" },
      { priority: "high" },
      { dueDate: null },
      { listItemType: "task" },
      { status: "cancelled", workflowReason: "Superseded" },
    ]);
  });

  test("maps every workflow command to one API update", () => {
    const ownerUserId = toSafeId<"user">("user-1");
    expect([
      workflowUpdateBody({
        type: "owner",
        value: { ownerUserId, reason: "Delegated" },
      }),
      workflowUpdateBody({ type: "workingTargetDate", value: null }),
      workflowUpdateBody({
        type: "hardDeadline",
        value: { hardDeadlineDate: "2026-08-20", reason: "Court order" },
      }),
      workflowUpdateBody({ type: "type", value: "deadline" }),
    ]).toEqual([
      { ownerUserId, reason: "Delegated" },
      { workingTargetDate: null },
      { hardDeadlineDate: "2026-08-20", reason: "Court order" },
      { type: "deadline" },
    ]);
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
