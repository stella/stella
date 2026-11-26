import { test as base } from "@playwright/test";

import { checkStormWatch, installStormWatch } from "./storm-watch";

/**
 * Playwright's `test` with the storm watch on every page: the context gets
 * the watch before its first page loads, and every page the test opened is
 * checked after it (./storm-watch.ts). The shared fixture (./test.ts) builds
 * on this one. A spec that wants Playwright's own fixtures without the
 * shared ones imports `test` from here, never from `@playwright/test`
 * (e2e/unit/storm-watch-coverage.test.ts holds every spec to that).
 */
export const test = base.extend<{
  /** Every test's pages must not storm, and must go quiet at its end. */
  stormWatch: undefined;
}>({
  // The watch must be in the context before its first page loads the app.
  context: async ({ context }, runFixture) => {
    await installStormWatch(context);
    await runFixture(context);
  },
  // Depends on `page` so the test's own page is still open when it is read.
  stormWatch: [
    async ({ context, page }, runFixture, testInfo) => {
      await runFixture(undefined);
      await checkStormWatch(context, page, testInfo);
    },
    { auto: true },
  ],
});
