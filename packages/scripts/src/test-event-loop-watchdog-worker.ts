// Worker half of test-event-loop-watchdog.ts. It runs on its own thread, so it
// keeps running while the test's event loop is blocked.

import { panic, Result } from "better-result";
import { writeSync } from "node:fs";

import {
  createEventLoopBlockDetector,
  descendantPids,
  eventLoopBlockedMessage,
  lastTestFile,
  parseProcessParents,
  TEST_EVENT_LOOP_PING_MS,
  testEventLoopBlockLimitMs,
} from "./test-event-loop-watchdog-policy";

declare const self: Worker;

// A monotonic clock: a test that sets the system time cannot move it.
const detector = createEventLoopBlockDetector({
  limitMs: testEventLoopBlockLimitMs(process.env),
  startedAt: performance.now(),
});
let main = Bun.main;

self.addEventListener("message", ({ data }: MessageEvent<string>) => {
  detector.answered(performance.now());
  main = data;
});

// Synchronous writes: the blocked thread cannot flush buffered output.
const report = (line: string) => {
  writeSync(2, `${line}\n`);
};

// Children a test spawned would keep the task's output pipes open after the
// leader dies. Windows test runners own the tree through a job object.
const descendants = (): readonly number[] => {
  if (process.platform === "win32") {
    return [];
  }
  const listed = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], {
    timeout: 1000,
  });
  if (!listed.success) {
    report(
      `Test event loop watchdog could not list child processes: ${listed.stderr.toString().trim()}`,
    );
    return [];
  }
  // The listing includes `ps` itself, which has exited.
  return descendantPids(
    process.pid,
    parseProcessParents(listed.stdout.toString()),
  ).filter((pid) => pid !== listed.pid);
};

const isGone = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ESRCH";

const terminate = (blockedMs: number) => {
  const children = descendants();
  for (const pid of children) {
    const signalled = Result.try(() => {
      process.kill(pid, "SIGKILL");
    });
    // A child that exited since the listing is already gone.
    if (signalled.isErr() && !isGone(signalled.error.cause)) {
      report(
        `Test event loop watchdog could not stop PID ${pid}: ${signalled.error.message}`,
      );
    }
  }
  report(
    `\n${eventLoopBlockedMessage({
      file: lastTestFile(main, process.cwd()),
      blockedMs,
      pid: process.pid,
      descendants: children.length,
    })}`,
  );
  process.kill(process.pid, "SIGKILL");
};

setInterval(() => {
  const state = detector.state(performance.now());
  switch (state.type) {
    case "turning":
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no targetOrigin param (window-only)
      self.postMessage(null);
      return;
    case "blocked":
      terminate(state.blockedMs);
      return;
    default:
      state satisfies never;
      panic("Unhandled event loop state");
  }
}, TEST_EVENT_LOOP_PING_MS);
