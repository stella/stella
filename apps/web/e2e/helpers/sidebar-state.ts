import type { BrowserContext } from "@playwright/test";
import { panic } from "better-result";

/**
 * Starts the app with the sidebar the way a user left it. Mirrors
 * `SIDEBAR_STATE_COOKIE` in src/lib/sidebar-state.ts, which the e2e project
 * cannot import (it has no DOM lib). A cookie, so the server render sees it too.
 */
export const seedSidebarState = async ({
  baseURL,
  context,
  state,
}: {
  baseURL: string | undefined;
  context: BrowserContext;
  state: "expanded" | "collapsed";
}) =>
  context.addCookies([
    {
      name: "sidebar_state",
      url:
        baseURL ??
        panic("Set the Playwright baseURL so the sidebar cookie has an origin"),
      value: state,
    },
  ]);
