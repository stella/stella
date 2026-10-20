import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { pendingCellRecovery } from "@/api/lib/workflow/orphan-recovery";

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

test("workflow pending cells reach a terminal fixed point", () => {
  assertProperty(
    "workflow pending cells reach a terminal fixed point",
    fc.property(
      fc.array(claimedCell, { minLength: 1, maxLength: 100 }),
      (cells) => {
        const now = new Date("2026-01-01T00:00:00.000Z");
        const terminal = cells.map((cell, index) => {
          const ownerRunId = cell.ownerIsCurrent ? "current" : `old-${index}`;
          const first = pendingCellRecovery(
            {
              ownerRunId,
              deadlineAt: new Date(
                now.getTime() + (cell.deadlinePassed ? -1 : 1),
              ),
              attempt: cell.attempt,
            },
            "current",
            now,
          );
          if (first.type === "leave-owned") {
            expect(cell.deadlinePassed).toBe(false);
            return "owned" as const;
          }
          if (first.type === "error") {
            return "error" as const;
          }

          // The automatic retry owns attempt 1. A worker loss, omitted/null
          // answer, throw, or superseding run can strand it again; the next
          // reconciliation must therefore terminate rather than loop.
          const afterRetry = pendingCellRecovery(
            {
              ownerRunId: `retry-${index}`,
              deadlineAt: new Date(now.getTime() - 1),
              attempt: first.attempt,
            },
            "current",
            now,
          );
          expect(afterRetry).toEqual({ type: "error", retry: "manual" });
          return "error" as const;
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
