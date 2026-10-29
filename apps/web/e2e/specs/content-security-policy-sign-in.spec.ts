import * as v from "valibot";

import type { AuthCapabilities } from "../../src/components/auth/sign-in-panel.logic";
import { installContentSecurityPolicyCollector } from "../helpers/content-security-policy";
import { expect, test } from "../helpers/test";

// The production E2E build enables both buttons. Stub only the auth metadata
// and authorization URL response so this browser boundary needs no credentials
// or provider account; the application still performs the navigation itself.
const PROVIDERS = [
  {
    name: "Google",
    id: "google",
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=csp-smoke",
  },
  {
    name: "Microsoft",
    id: "microsoft",
    url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=csp-smoke",
  },
] as const;

test.use({ storageState: { cookies: [], origins: [] }, locale: "en-US" });

for (const provider of PROVIDERS) {
  test(`sign-in navigates to ${provider.name} without CSP violations`, async ({
    page,
  }) => {
    const csp = await installContentSecurityPolicyCollector(page);
    await page.route("**/v1/auth/capabilities", async (route) => {
      const capabilities = {
        emailOtp: true,
        localPassword: false,
        reviewPasswordSignIn: false,
        bootstrap: false,
        social: { google: true, microsoft: true, apple: false },
      } satisfies AuthCapabilities;
      await route.fulfill({
        json: { ...capabilities, transactionalEmail: true },
      });
    });
    await page.route("**/api/auth/sign-in/social", async (route) => {
      const body = v.parse(
        v.object({ provider: v.string() }),
        route.request().postDataJSON(),
      );
      expect(body.provider).toBe(provider.id);
      await route.fulfill({ json: { url: provider.url, redirect: true } });
    });
    let navigationTarget: string | undefined;
    await page.route(`${new URL(provider.url).origin}/**`, async (route) => {
      expect(route.request().isNavigationRequest()).toBe(true);
      expect(route.request().frame()).toBe(page.mainFrame());
      const target = route.request().url();
      await route.abort();
      navigationTarget = target;
    });
    await page.goto("/auth", { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", {
      name: `Continue with ${provider.name}`,
      exact: true,
    });
    await expect(button).toBeVisible();
    await csp.assertClean();
    await button.click();
    await expect.poll(() => navigationTarget).toBe(provider.url);
    // The click and the navigation it started report into the collector.
    csp.assertNoViolations();
  });
}
