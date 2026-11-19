import type { Page } from "@playwright/test";

import { getStorageKey } from "../../src/consts";
import { apiJson, respond } from "../helpers/route-mock";
import { expect, test } from "../helpers/test";

const viewport = { width: 1440, height: 900 };

test.use({ viewport, storageState: { cookies: [], origins: [] } });

const signIn = {
  path: "/auth",
  title: "h2",
  control: '[data-slot="input-face"], [data-slot="input-control"]',
  loaded: 'input[type="email"]',
} as const;

const forms = [
  { ...signIn, providers: "all" },
  { ...signIn, providers: "one" },
  { ...signIn, providers: "none" },
  {
    path: "/auth/two-factor",
    title: '[data-slot="frame-panel-title"]',
    control: '[data-slot="input-otp-group"]',
    loaded: "input[data-input-otp]",
  },
  {
    path: "/auth/error",
    title: '[data-slot="frame-panel-title"]',
    control: '[data-slot="frame-panel"] :is(button, [data-slot="button-face"])',
    loaded: '[data-slot="frame-panel"] button',
  },
] as const;

const landmarks = async (page: Page, form: (typeof forms)[number]) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return Promise.all(
    ["header a", form.title, form.control].map(async (selector) => {
      // React keeps the previous Suspense tree hidden during hydration.
      const node = page.locator(selector).filter({ visible: true }).first();
      await expect(node).toBeVisible();
      return node.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height];
      });
    }),
  );
};

const providerRows = (page: Page) =>
  page.locator("[data-auth-provider]").filter({ visible: true });

const providerLandmarks = async (page: Page) =>
  await providerRows(page).evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const provider = element.dataset["authProvider"];
      if (!provider) {
        throw new TypeError("Configured provider rows require a provider ID");
      }
      return {
        provider,
        rectangle: [x, y, width, height],
      };
    }),
  );

const enabledProviders = (
  configured: readonly string[],
  availability: "all" | "one" | "none",
) => {
  switch (availability) {
    case "all":
      return new Set(configured);
    case "one":
      // With multiple configured rows, keep a later one enabled so as to
      // exercise reserved space above the remaining control.
      return new Set(configured.slice(-1));
    case "none":
      return new Set<string>();
    default:
      availability satisfies never;
      throw new TypeError("Unexpected provider availability");
  }
};

const expectAvailableProviders = async (
  page: Page,
  configured: readonly string[],
  enabled: ReadonlySet<string>,
) => {
  const rows = providerRows(page);
  await expect(rows).toHaveCount(configured.length);
  for (const [index, provider] of configured.entries()) {
    const row = rows.nth(index);
    if (enabled.has(provider)) {
      const button = row.getByRole("button");
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      await expect(button).toContainText(provider, { ignoreCase: true });
      const beforeEmail = await button.evaluate((element, inputSelector) => {
        const email = document.querySelector(inputSelector);
        return (
          email !== null &&
          element.compareDocumentPosition(email) ===
            Node.DOCUMENT_POSITION_FOLLOWING &&
          element.getBoundingClientRect().bottom <=
            email.getBoundingClientRect().top
        );
      }, signIn.loaded);
      expect(beforeEmail).toBe(true);
    } else {
      await expect(row.locator('button, [role="button"], a')).toHaveCount(0);
    }
  }
};

for (const locale of ["en", "cs"]) {
  for (const form of forms) {
    const variant = "providers" in form ? ` (${form.providers} providers)` : "";
    test(`${form.path}${variant} keeps its landmarks through hydration in ${locale}`, async ({
      baseURL,
      browser,
      page,
    }, testInfo) => {
      if (baseURL === undefined) {
        throw new TypeError("Auth geometry needs the web base URL");
      }
      const cold = await browser.newPage({
        baseURL,
        javaScriptEnabled: false,
        locale,
        viewport,
      });
      const session = Promise.withResolvers<undefined>();
      try {
        await cold.goto(form.path);
        const server = await landmarks(cold, form);
        const serverProviders =
          form.path === "/auth" ? await providerLandmarks(cold) : [];
        const configured = serverProviders.map(({ provider }) => provider);
        const enabled = enabledProviders(
          configured,
          form.path === "/auth" ? form.providers : "none",
        );

        await page.addInitScript(
          ({ key, lang }) => {
            localStorage.setItem(
              key,
              JSON.stringify({ state: { lang }, version: 0 }),
            );
          },
          { key: getStorageKey("i18n"), lang: locale },
        );
        if (form.path === "/auth") {
          const offersAll = form.providers === "all";
          await page.route(
            "**/v1/auth/capabilities",
            async (route) =>
              await respond(
                route,
                apiJson("v1/auth/capabilities", "get", {
                  emailOtp: true,
                  localPassword: false,
                  reviewPasswordSignIn: false,
                  bootstrap: false,
                  transactionalEmail: true,
                  social: {
                    google: offersAll || enabled.has("google"),
                    microsoft: offersAll || enabled.has("microsoft"),
                    apple: offersAll || enabled.has("apple"),
                  },
                }),
              ),
          );
        }
        await page.route(
          (url) => url.pathname === "/api/auth/get-session",
          async (route) => {
            await session.promise;
            await route.continue();
          },
        );
        const sessionRequested = page.waitForRequest(
          (request) =>
            new URL(request.url()).pathname === "/api/auth/get-session",
        );
        await page.goto(form.path, { waitUntil: "commit" });
        await sessionRequested;
        const pending = await landmarks(page, form);
        const pendingProviders =
          form.path === "/auth" ? await providerLandmarks(page) : [];
        session.resolve(undefined);
        await expect(page.locator(form.loaded).first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const loaded = await landmarks(page, form);
        const loadedProviders =
          form.path === "/auth" ? await providerLandmarks(page) : [];

        await testInfo.attach("geometry.json", {
          contentType: "application/json",
          body: JSON.stringify({
            locale,
            path: form.path,
            server,
            pending,
            loaded,
            providers: {
              configured,
              enabled: [...enabled],
              server: serverProviders,
              pending: pendingProviders,
              loaded: loadedProviders,
            },
          }),
        });
        expect(pending).toEqual(server);
        expect(loaded).toEqual(server);
        if (form.path === "/auth") {
          expect(pendingProviders).toEqual(serverProviders);
          expect(loadedProviders).toEqual(serverProviders);
          await expectAvailableProviders(page, configured, enabled);
        }
      } finally {
        session.resolve(undefined);
        await cold.close();
      }
    });
  }
}
