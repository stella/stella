// Bun test preload, listed first in every workspace bunfig.toml `[test]`
// (packages/scripts/src/test-event-loop-watchdog-coverage.test.ts enforces it).
// A worker thread pings this event loop and kills the process when the pings
// stop being answered; see test-event-loop-watchdog-policy.ts for the bound.
//
// The answer is a message task, not a timer, so fake timers cannot silence it.
// Each answer, and each test start, carries Bun.main (the test file being
// loaded or run), so the kill names the file even when Bun prints no file
// headers. Under --isolate this preload runs again per file; Bun terminates
// the previous file's worker.

import { beforeEach } from "bun:test";

const startEventLoopWatchdog = () => {
  // A debugger paused at a breakpoint blocks the loop on purpose.
  if (process.execArgv.some((argument) => argument.startsWith("--inspect"))) {
    return;
  }
  const worker = new Worker(
    new URL("test-event-loop-watchdog-worker.ts", import.meta.url).href,
  );
  const answer = () => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin param (window-only)
    worker.postMessage(Bun.main);
  };
  worker.addEventListener("message", answer);
  worker.unref();
  // A test can block before its file answers a ping.
  beforeEach(answer);
};

startEventLoopWatchdog();
