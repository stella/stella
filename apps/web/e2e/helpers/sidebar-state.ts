import type { BrowserContext } from "@playwright/test";
import { panic } from "better-result";

import { SIDEBAR_STATE_VALUES } from "../../src/components/sidebar/sidebar-state-cookie";
import { setPresentationPrefs } from "./presentation-prefs";

type SeedSidebarStateOptions = {
  baseURL: string | undefined;
  context: BrowserContext;
  state: (typeof SIDEBAR_STATE_VALUES)[keyof typeof SIDEBAR_STATE_VALUES];
};

export const seedSidebarState = async ({
  baseURL,
  context,
  state,
}: SeedSidebarStateOptions) =>
  setPresentationPrefs({
    context,
    url:
      baseURL ??
      panic("Set the Playwright baseURL so the sidebar cookie has an origin"),
    patch: { sidebarOpen: state === SIDEBAR_STATE_VALUES.expanded },
  });
