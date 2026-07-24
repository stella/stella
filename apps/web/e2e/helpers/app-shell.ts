import type { Page } from "@playwright/test";

/**
 * Locate primary app navigation by shell ownership and destination. Route
 * content can repeat the same link in breadcrumbs, so a page-wide accessible
 * name is not a readiness signal for the shell.
 */
export const appShellNavigationLink = (page: Page, path: `/${string}`) =>
  page.locator('[data-slot="sidebar"]').locator(`a[href="${path}"]`);
