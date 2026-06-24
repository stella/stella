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

// Static assets (lazy route chunks, wasm runtimes, styles, fonts, images) must
// never 404: a missing chunk surfaces only as this console error while the
// shell still renders, so those stay fatal. Smoke specs deliberately probe
// non-existent records (random thread/entity ids), so 404s from data/API
// requests are tolerated.
const STATIC_ASSET_URL =
  /\.(?:js|mjs|cjs|wasm|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico)(?:[?#]|$)/u;

// React's dev-only warning when a non-suspense useQuery on a cold cache resolves
// its fetch before the rendering fiber commits (TanStack Query starts the fetch
// during render). It is harmless in production (no warning, and the update lands
// after mount) and never reflects an app bug here. Persistent chrome defers these
// fetches past mount via useChromeQuery, but route content reaches the same
// pattern through dozens of components, so gating route-smoke on this specific
// warning would be unbounded whack-a-mole. Tolerate exactly this message; every
// other console.error (including any genuinely different render-time bug) still
// fails the run.
const REACT_QUERY_COLD_MOUNT_WARNING =
  /Can't perform a React state update on a component that hasn't mounted yet/u;

const isToleratedResourceNotFound = (message: ConsoleMessage): boolean =>
  RESOURCE_NOT_FOUND_CONSOLE_ERROR.test(message.text()) &&
  !STATIC_ASSET_URL.test(message.location().url);

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

        if (REACT_QUERY_COLD_MOUNT_WARNING.test(text)) {
          return;
        }

        if (isToleratedResourceNotFound(message)) {
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
