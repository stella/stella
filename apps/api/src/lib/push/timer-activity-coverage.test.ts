import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A timer that changes without its owner's Lock Screen hearing of it shows a
 * clock that is wrong until the app next opens. Every module that writes the
 * timers, or calls what does, is named here with how its change reaches the
 * phone; a new writer fails until it is named too.
 */
const SOURCE_ROOT = path.join(import.meta.dir, "..", "..");

const SCHEDULES = "schedules";

const TIMER_WRITERS: Record<string, typeof SCHEDULES | { reason: string }> = {
  "handlers/time-timers/start.ts": SCHEDULES,
  "handlers/time-timers/update.ts": SCHEDULES,
  "handlers/time-timers/discard.ts": SCHEDULES,
  "handlers/time-timers/confirm.ts": SCHEDULES,
  "handlers/time-timers/admin/stop.ts": SCHEDULES,
  // Pause and resume run `timerStateTransition`, which schedules.
  "lib/billing/time-timers.ts": SCHEDULES,
  "handlers/me/timer-activity-devices/act.ts": {
    reason:
      "A Lock Screen button runs `timerStateTransition`, which schedules.",
  },
  "handlers/time-timers/pause.ts": {
    reason: "Its handler is `timerStateTransition`, which schedules.",
  },
  "handlers/time-timers/resume.ts": {
    reason: "Its handler is `timerStateTransition`, which schedules.",
  },
  "handlers/time-timers/finalize.ts": {
    reason:
      "Runs inside confirm and admin stop, which schedule once their transaction commits.",
  },
  "lib/time-entry-offboarding.ts": {
    reason:
      "Pauses a removed member's timers inside the removal; the member's app is signed out of the organization, which ends its activity.",
  },
};

const WRITE_PATTERN =
  /\.(?:insert|update|delete)\(timeTimers\)|\b(?:finalizeTimer|pauseRunningTimers|changeTimerState|timerStateTransition)\(/u;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(full);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [full]
      : [];
  });

const writers = sourceFiles(SOURCE_ROOT)
  .filter((file) => WRITE_PATTERN.test(readFileSync(file, "utf-8")))
  .map((file) =>
    file
      .slice(SOURCE_ROOT.length + 1)
      .split(path.sep)
      .join("/"),
  )
  .toSorted();

describe("timer writes reach the Lock Screen", () => {
  test("every module that changes timers is named with how it reaches the phone", () => {
    expect(writers).toEqual(Object.keys(TIMER_WRITERS).toSorted());
  });

  test.each(
    Object.entries(TIMER_WRITERS).filter(([, how]) => how === SCHEDULES),
  )("%s schedules the update after its write", (file) => {
    expect(readFileSync(path.join(SOURCE_ROOT, file), "utf-8")).toContain(
      "scheduleTimerActivityUpdates(",
    );
  });
});
