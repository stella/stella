import { test as base } from "@playwright/test";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "@playwright/test";

import { checkStormWatch, installStormWatch } from "./storm-watch";

/**
 * Playwright's `test` with the storm watch on every page: the context gets
 * the watch before its first page loads, and every page the test opened is
 * checked after it (./storm-watch.ts). The shared fixture (./test.ts) builds
 * on this one. A spec that wants Playwright's own fixtures without the
 * shared ones imports `test` from here, never from `@playwright/test`, and
 * opens contexts of its own through `newWatchedContext` / `newWatchedPage`
 * (e2e/unit/storm-watch-coverage.test.ts holds every spec to both).
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

/**
 * `browser.newContext(options)` under the storm watch. Its pages are checked
 * when it closes, while they are still open, and the result is recorded on
 * the running test (and fails it in enforce mode) just as for the test's own
 * context.
 */
export const newWatchedContext = async (
  browser: Browser,
  options?: BrowserContextOptions,
): Promise<BrowserContext> => {
  const context = await browser.newContext(options);
  await installStormWatch(context);
  const testInfo = test.info();
  const closeContext = context.close.bind(context);
  let checked = false;
  context.close = async (...args) => {
    try {
      if (!checked) {
        checked = true;
        await checkStormWatch(context, null, testInfo);
      }
    } finally {
      await closeContext(...args);
    }
  };
  return context;
};

/**
 * `browser.newPage(options)` under the storm watch: the page owns a watched
 * context of its own, which closing the page checks and closes.
 */
export const newWatchedPage = async (
  browser: Browser,
  options?: BrowserContextOptions,
): Promise<Page> => {
  const context = await newWatchedContext(browser, options);
  const page = await context.newPage();
  page.close = async () => {
    await context.close();
  };
  return page;
};
