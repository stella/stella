import type { BrowserContext } from "@playwright/test";
import { panic } from "better-result";

import { SIDEBAR_STATE_COOKIE } from "../../src/components/sidebar/sidebar-state-cookie";
import type { SidebarStateValue } from "../../src/components/sidebar/sidebar-state-cookie";

/**
 * Starts the app with the sidebar the way a user left it, using the same
 * cookie contract as the server render without importing browser APIs.
 */
export const seedSidebarState = async ({
  baseURL,
  context,
  state,
}: {
  baseURL: string | undefined;
  context: BrowserContext;
  state: SidebarStateValue;
}) =>
  context.addCookies([
    {
      name: SIDEBAR_STATE_COOKIE,
      url:
        baseURL ??
        panic("Set the Playwright baseURL so the sidebar cookie has an origin"),
      value: state,
    },
  ]);
