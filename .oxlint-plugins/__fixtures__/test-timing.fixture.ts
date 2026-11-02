// Passive regression fixture for `test-timing`.
//
// Each `oxlint-disable-next-line` suppresses a case the rule MUST flag; if the
// rule regresses, the unused directive fails the fixture harness. A blank line
// separates each case description from its case, because a `real-time:`
// comment directly above a wait counts as its reason.

import { setDefaultTimeout, test } from "bun:test";
import { setTimeout as wait } from "node:timers/promises";

import { sleep } from "@stll/concurrency/sleep";

declare const page: { waitForTimeout: (ms: number) => Promise<void> };

// Bun's sleeps

// oxlint-disable-next-line test-timing/no-real-time-wait
await Bun.sleep(5);

// timers/promises

// oxlint-disable-next-line test-timing/no-real-time-wait
await wait(5);

// the shared sleep helper

// oxlint-disable-next-line test-timing/no-real-time-wait
await sleep(5);

// Playwright

// oxlint-disable-next-line test-timing/no-real-time-wait
await page.waitForTimeout(500);

// a promise settled from the global setTimeout

// oxlint-disable-next-line test-timing/no-real-time-wait
await new Promise((resolve) => {
  setTimeout(resolve, 5);
});

// a timer that is not awaited is not a wait

// expect-clean: test-timing/no-real-time-wait
clearTimeout(setTimeout(() => undefined, 5));

// real time as the behaviour under test
// real-time: the delay itself is what this case measures
// expect-clean: test-timing/no-real-time-wait
await Bun.sleep(5);

// --- no-polling-loop ---

declare const done: () => boolean;

// a counted loop whose test also asks the system under test
// oxlint-disable-next-line test-timing/no-polling-loop
for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
  // oxlint-disable-next-line test-timing/no-real-time-wait
  await sleep(5);
}

// a conditional exit between scheduler ticks
// oxlint-disable-next-line test-timing/no-polling-loop
while (true) {
  if (done()) {
    break;
  }
  await Promise.resolve();
}

// a fixed-count flush is not a poll
// expect-clean: test-timing/no-polling-loop
for (let pass = 0; pass < 3; pass += 1) {
  await Promise.resolve();
}

// --- no-unreasoned-timeout ---

// a per-test timeout above Bun's default

// oxlint-disable-next-line test-timing/no-unreasoned-timeout
test("slow case", () => undefined, 30_000);

// a raised suite default

// oxlint-disable-next-line test-timing/no-unreasoned-timeout
setDefaultTimeout(60_000);

// a default-sized budget
// expect-clean: test-timing/no-unreasoned-timeout
test("bounded case", () => undefined, 2000);

// timeout: the case starts a real database cluster
// expect-clean: test-timing/no-unreasoned-timeout
test("reasoned case", () => undefined, 30_000);

// --- no-literal-wait-timeout ---

declare const waitFor: (
  check: () => void,
  options?: { timeout?: number },
) => Promise<void>;
declare const ready: () => void;

// a per-call timeout on a DOM condition wait

// oxlint-disable-next-line test-timing/no-literal-wait-timeout
await waitFor(ready, { timeout: 1000 });

// a DOM wait under the shared hang guard
// expect-clean: test-timing/no-literal-wait-timeout
await waitFor(ready);

// real-time: the subject polls its status on its own interval
// expect-clean: test-timing/no-literal-wait-timeout
await waitFor(ready, { timeout: 5000 });
