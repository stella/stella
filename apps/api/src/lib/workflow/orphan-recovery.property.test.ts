import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { reconcilePendingCells } from "@/api/lib/workflow/orphan-recovery";

const fault = fc.constantFrom(
  "batch-throws",
  "worker-killed",
  "superseded-run",
  "concurrent-run",
  "null-answer",
  "omitted-property",
);

const claimedCell = fc.record({
  attempt: fc.constantFrom(0 as const, 1 as const),
  fault,
  ownerIsCurrent: fc.boolean(),
  deadlinePassed: fc.boolean(),
});

test("scheduled workflow reconciliation drives claimed cells to a terminal fixed point", async () => {
  await assertProperty(
    "scheduled workflow reconciliation drives claimed cells to a terminal fixed point",
    fc.asyncProperty(
      fc.array(claimedCell, { minLength: 1, maxLength: 100 }),
      async (cells) => {
        const now = new Date("2026-01-01T00:00:00.000Z");
        const pending = cells.map((cell, index) => ({
          id: String(index).padStart(3, "0"),
          workspaceId: `workspace-${index % 3}`,
          ownerRunId: cell.ownerIsCurrent ? "current" : `old-${index}`,
          deadlineAt: new Date(now.getTime() + (cell.deadlinePassed ? -1 : 1)),
          attempt: cell.attempt,
          state: "pending" as "pending" | "owned" | "error",
        }));
        const run = async () =>
          await reconcilePendingCells({
            now,
            pageSize: 7,
            selectPage: async (cursor, limit) =>
              pending
                .filter(
                  ({ id, state }) =>
                    state === "pending" && (cursor === null || id > cursor),
                )
                .slice(0, limit),
            currentRunId: async () => "current",
            retry: async (cell) => {
              cell.ownerRunId = `retry-${cell.id}`;
              cell.deadlineAt = new Date(now.getTime() - 1);
              cell.attempt = 1;
            },
            error: async (cell) => {
              cell.state = "error";
            },
          });
        await run();
        await run();
        const terminal = pending.map((cell) => {
          if (cell.ownerRunId === "current" && cell.deadlineAt > now) {
            cell.state = "owned";
          }
          return cell.state;
        });

        // Quiescence permits only a live, unexpired owner or a terminal cell.
        expect(
          terminal.every((state) => state === "owned" || state === "error"),
        ).toBe(true);
        // An owned cell keeps its column stale; only a batch with no owners
        // may make the projection fresh.
        const propertyIsFresh = !terminal.includes("owned");
        expect(propertyIsFresh && terminal.includes("owned")).toBe(false);
      },
    ),
    { numRuns: 300 },
  );
});
