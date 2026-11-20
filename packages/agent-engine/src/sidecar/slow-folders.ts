import type { DesktopRunnerCheckpointEvent } from "@stll/api-contract/desktop-runner";

/** Captures in a row a folder may run out of time on before it is skipped. */
const SLOW_CAPTURES_TO_SKIP = 2;

/** How long a folder too slow to save is skipped before it is tried again. */
const SKIP_MS = 60 * 60_000;

/** The report of a capture a folder too slow to save is spared. */
export const SKIPPED_CAPTURE: DesktopRunnerCheckpointEvent = {
  status: "unavailable",
  reason: "too_slow",
};

/**
 * Folders whose capture keeps running out of its time budget. Every run's
 * start waits on the capture, so a folder that cannot be saved in time (a
 * slow network share, say) would cost each turn the whole budget for the
 * same `too_slow`. After `SLOW_CAPTURES_TO_SKIP` of those in a row, its runs
 * start without one for `SKIP_MS`, then the next run tries again. In memory
 * only: a restarted sidecar measures afresh.
 */
export class SlowCheckpointFolders {
  private readonly folders = new Map<
    string,
    { slow: number; skipUntil: number }
  >();

  /** Whether a run in `folder` starting at `now` skips its capture. */
  skips(folder: string, now: number): boolean {
    const known = this.folders.get(folder);
    return known !== undefined && now < known.skipUntil;
  }

  /** What a capture in `folder` came to, at `now`. */
  record(folder: string, captured: DesktopRunnerCheckpointEvent, now: number) {
    if (captured.status !== "unavailable" || captured.reason !== "too_slow") {
      this.folders.delete(folder);
      return;
    }
    const slow = (this.folders.get(folder)?.slow ?? 0) + 1;
    this.folders.set(folder, {
      slow,
      skipUntil: slow >= SLOW_CAPTURES_TO_SKIP ? now + SKIP_MS : 0,
    });
  }
}
