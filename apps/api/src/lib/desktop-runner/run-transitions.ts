import {
  desktopRunnerFolderRestores,
  desktopRunnerRuns,
} from "@/api/db/schema";
import { defineLifecycle } from "@/api/lib/db/transitions";

/**
 * Where a run may move, from the store's writes:
 *
 * - `assigned` → `running` when the desktop accepts it or lists it in
 *   `hello`; → `waiting_for_computer` when its lease lapses; → `rejected`
 *   when the desktop refuses it; → `lost` when no desktop accepted it within
 *   the abandon window.
 * - `running` → `waiting_for_computer` when its lease lapses; → `finished`
 *   with `run.finished`; → `lost` when the desktop comes back without it.
 * - `waiting_for_computer` → `assigned` or `running` (by whether it was ever
 *   accepted) when its desktop is back; → `finished` or `running` with the
 *   desktop's next run message; → `rejected` when a run it never accepted is
 *   refused; → `lost` when the desktop comes back without an accepted run,
 *   or never comes back within the abandon window.
 *
 * A run never moves to another desktop, so no edge leaves the final states.
 */
export const DESKTOP_RUNNER_RUN_TRANSITIONS = defineLifecycle({
  table: desktopRunnerRuns,
  key: "runId",
  graphs: {
    state: {
      edges: {
        assigned: ["running", "waiting_for_computer", "rejected", "lost"],
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

/**
 * Where a folder restore may move, from the store's writes:
 *
 * - `queued` → `sent` when a socket of its computer takes it; → `expired`
 *   when no socket took it in time. It is marked sent before it goes out, so
 *   no answer comes for a queued one.
 * - `sent` → `restored` or `refused` with the computer's answer, however
 *   late; it is sent again on every new socket until then; → `expired` when
 *   a relink retired its computer's device key, so no answer can come.
 */
export const DESKTOP_RUNNER_FOLDER_RESTORE_TRANSITIONS = defineLifecycle({
  table: desktopRunnerFolderRestores,
  key: "id",
  graphs: {
    state: {
      edges: {
        queued: ["sent", "expired"],
        sent: ["restored", "refused", "expired"],
        restored: [],
        refused: [],
        expired: [],
      },
      terminal: ["restored", "refused", "expired"],
    },
  },
});
