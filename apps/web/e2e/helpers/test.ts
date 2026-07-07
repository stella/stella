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
// IO_SUSPENDED and SOCKET_NOT_CONNECTED fire when the host sleeps or the
// network stack resets mid-request (laptop lid, VPN reconnect) — possible on
// local runs, same transport family, never an app bug.
const TRANSIENT_NETWORK_ERROR =
  /net::(?:ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_SOCKET_NOT_CONNECTED)/u;
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
// warning would be unbounded whack-a-mole. route-smoke opts in to tolerate
// exactly this message (see tolerateColdMountWarning); other specs keep it
// fatal, and every other console.error always fails the run.
const REACT_QUERY_COLD_MOUNT_WARNING =
  /Can't perform a React state update on a component that hasn't mounted yet/u;

const isToleratedResourceNotFound = (message: ConsoleMessage): boolean =>
  RESOURCE_NOT_FOUND_CONSOLE_ERROR.test(message.text()) &&
  !STATIC_ASSET_URL.test(message.location().url);

const redactUrlQuery = (url: string): string => {
  if (url === "") {
    return "";
  }

  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const suffixIndex = url.search(/[?#]/u);
    return suffixIndex === -1 ? url : url.slice(0, suffixIndex);
  }
};

type BrowserErrorCollectorOptions = {
  // Only route-smoke opts in: it walks every authenticated route and so hits
  // the unbounded route-content tail of the cold-mount warning. Other specs
  // (e.g. upload-docx) keep the warning fatal, preserving a runtime guard
  // against a useChromeQuery regression or a new bare-useQuery chrome path.
  tolerateColdMountWarning?: boolean;
};

export const createBrowserErrorCollector = (
  options: BrowserErrorCollectorOptions = {},
): BrowserErrorCollector & {
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

        if (
          options.tolerateColdMountWarning &&
          REACT_QUERY_COLD_MOUNT_WARNING.test(text)
        ) {
          return;
        }

        if (isToleratedResourceNotFound(message)) {
          return;
        }

        // "Failed to load resource" console errors carry the failing URL only
        // in message.location(); without it a 4xx/5xx failure is undebuggable
        // from the assertion output alone.
        const failedUrl = redactUrlQuery(message.location().url);
        errors.push(
          failedUrl === ""
            ? `console.error: ${text}`
            : `console.error: ${text} (${failedUrl})`,
        );
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
