// Passive regression fixture for `test-timing`.
//
// Each `oxlint-disable-next-line` suppresses a case the rule MUST flag; if the
// rule regresses, the unused directive fails the fixture harness. A blank line
// separates each case description from its case, because a `real-time:`
// comment directly above a wait counts as its reason.

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
