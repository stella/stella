import { expect, test as base } from "@playwright/test";
import type { ConsoleMessage, Page } from "@playwright/test";

export type BrowserErrorCollector = {
  entries: () => string[];
  assertEmpty: (label: string) => void;
  trackPage: (page: Page) => () => void;
};

type BrowserErrorFixtures = {
  browserErrors: BrowserErrorCollector;
};

// Transport-layer connection drops the browser reports as console errors.
// These are dev-server infra flakes, not app errors. Match only dropped
// connection codes, not the broader "failed to load resource" family.
const TRANSIENT_NETWORK_ERROR =
  /net::(?:ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_NETWORK_CHANGED)/u;
const RESOURCE_NOT_FOUND_CONSOLE_ERROR =
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/u;

export const createBrowserErrorCollector = (): BrowserErrorCollector & {
  add: (message: string) => void;
} => {
  const errors: string[] = [];

  return {
    add: (message) => {
      errors.push(message);
    },
    entries: () => [...errors],
    assertEmpty: (label) => {
      const collected = errors.splice(0);
      expect(collected, `${label}\n\n${collected.join("\n\n")}`).toEqual([]);
    },
    trackPage: (page) => {
      const onPageError = (error: Error) => {
        errors.push(`pageerror: ${error.message}`);
      };

      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== "error") {
          return;
        }

        const text = message.text();
        if (TRANSIENT_NETWORK_ERROR.test(text)) {
          return;
        }

        if (RESOURCE_NOT_FOUND_CONSOLE_ERROR.test(text)) {
          return;
        }

        errors.push(`console.error: ${text}`);
      };

      page.on("pageerror", onPageError);
      page.on("console", onConsole);

      return () => {
        page.off("pageerror", onPageError);
        page.off("console", onConsole);
      };
    },
  };
};

export const test = base.extend<BrowserErrorFixtures>({
  browserErrors: [
    async ({ page }, runFixture) => {
      const browserErrors = createBrowserErrorCollector();
      const detachPage = browserErrors.trackPage(page);

      try {
        await runFixture(browserErrors);
      } finally {
        detachPage();
      }

      browserErrors.assertEmpty("unexpected browser errors");
    },
    { auto: true },
  ],
});

export { expect };
