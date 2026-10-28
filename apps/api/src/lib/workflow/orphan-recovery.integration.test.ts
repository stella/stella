import { expect, test } from "bun:test";

import { reconcilePendingCells } from "@/api/lib/workflow/orphan-recovery";

test("a cell whose run died is retried once through the planner and fills", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const cell = {
    id: "cell-1",
    workspaceId: "workspace-1",
    ownerRunId: "dead-run",
    deadlineAt: new Date(now.getTime() - 1),
    attempt: 0 as 0 | 1,
    state: "pending" as "pending" | "filled" | "error",
  };
  const plannedAttempts: number[] = [];

  await reconcilePendingCells({
    now,
    pageSize: 10,
    selectPage: async () => (cell.state === "pending" ? [cell] : []),
    currentRunId: async () => "live-unrelated-run",
    retry: async (claimed, attempt) => {
      plannedAttempts.push(attempt);
      claimed.attempt = attempt;
      // This seam represents the normal planner and worker completing the
      // targeted entity/property run after recovery handed it attempt one.
      claimed.state = "filled";
    },
    error: async (claimed) => {
      claimed.state = "error";
    },
  });

  expect(plannedAttempts).toEqual([1]);
  expect(cell.state).toBe("filled");
});
