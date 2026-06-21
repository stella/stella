import { expect, test as base } from "@playwright/test";
import type { ConsoleMessage } from "@playwright/test";

type BrowserErrorCollector = {
  entries: () => string[];
  assertEmpty: (label: string) => void;
};

type BrowserErrorFixtures = {
  browserErrors: BrowserErrorCollector;
};

// Transport-layer connection drops the browser reports as console errors.
// These are dev-server infra flakes, not app errors. Match only dropped
// connection codes, not the broader "failed to load resource" family.
const TRANSIENT_NETWORK_ERROR =
  /net::(?:ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_NETWORK_CHANGED)/u;

const createBrowserErrorCollector = (): BrowserErrorCollector & {
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
  };
};

export const test = base.extend<BrowserErrorFixtures>({
  browserErrors: [
    async ({ page }, runFixture) => {
      const browserErrors = createBrowserErrorCollector();

      const onPageError = (error: Error) => {
        browserErrors.add(`pageerror: ${error.message}`);
      };

      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== "error") {
          return;
        }

        const text = message.text();
        if (TRANSIENT_NETWORK_ERROR.test(text)) {
          return;
        }

        browserErrors.add(`console.error: ${text}`);
      };

      page.on("pageerror", onPageError);
      page.on("console", onConsole);

      try {
        await runFixture(browserErrors);
      } finally {
        page.off("pageerror", onPageError);
        page.off("console", onConsole);
      }

      browserErrors.assertEmpty("unexpected browser errors");
    },
    { auto: true },
  ],
});

export { expect };
