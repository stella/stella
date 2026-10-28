import { desktopRunnerRuns } from "@/api/db/schema";
import { defineLifecycle } from "@/api/lib/db/transitions";

/**
 * Where a run may move, from the store's writes:
 *
 * - `assigned` → `running` when the desktop accepts it or lists it in
 *   `hello`; → `waiting_for_computer` when its lease lapses; → `rejected`
 *   when the desktop refuses it.
 * - `running` → `waiting_for_computer` when its lease lapses; → `finished`
 *   with `run.finished`; → `lost` when the desktop comes back without it.
 * - `waiting_for_computer` → `assigned` or `running` (by whether it was ever
 *   accepted) when its desktop is back; → `finished` or `running` with the
 *   desktop's next run message; → `rejected` when a run it never accepted is
 *   refused; → `lost` when the desktop comes back without an accepted run.
 *
 * A run never moves to another desktop, so no edge leaves the final states.
 */
export const DESKTOP_RUNNER_RUN_TRANSITIONS = defineLifecycle({
  table: desktopRunnerRuns,
  key: "runId",
  graphs: {
    state: {
      edges: {
        assigned: ["running", "waiting_for_computer", "rejected"],
        running: ["waiting_for_computer", "finished", "lost"],
        waiting_for_computer: [
          "assigned",
          "running",
          "finished",
          "rejected",
          "lost",
        ],
        finished: [],
        rejected: [],
        lost: [],
      },
      terminal: ["finished", "rejected", "lost"],
    },
  },
});
