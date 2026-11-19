import type { Page } from "@playwright/test";

import { getStorageKey } from "../../src/consts";
import { apiJson, respond } from "../helpers/route-mock";
import { expect, test } from "../helpers/test";

const viewport = { width: 1440, height: 900 };

test.use({ viewport, storageState: { cookies: [], origins: [] } });

const forms = [
  {
    path: "/auth",
    title: "h2",
    control: '[data-slot="input-face"], [data-slot="input-control"]',
    loaded: 'input[type="email"]',
  },
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
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return Promise.all(
    ["header a", form.title, form.control].map(async (selector) => {
      const node = page.locator(selector).first();
      await expect(node).toBeVisible();
      return node.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map(Math.round);
      });
    }),
  );
};

for (const locale of ["en", "cs"]) {
  for (const form of forms) {
    test(`${form.path} keeps its landmarks through hydration in ${locale}`, async ({
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
          // Exercise every provider enabled in this build without external accounts.
          await page.route("**/v1/auth/capabilities", (route) =>
            respond(
              route,
              apiJson("v1/auth/capabilities", "get", {
                emailOtp: true,
                localPassword: false,
                reviewPasswordSignIn: false,
                bootstrap: false,
                transactionalEmail: true,
                social: { google: true, microsoft: true, apple: true },
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
        session.resolve(undefined);
        await expect(page.locator(form.loaded).first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const loaded = await landmarks(page, form);

        await testInfo.attach("geometry.json", {
          contentType: "application/json",
          body: JSON.stringify({
            locale,
            path: form.path,
            server,
            pending,
            loaded,
          }),
        });
        expect(pending).toEqual(server);
        expect(loaded).toEqual(server);
      } finally {
        session.resolve(undefined);
        await cold.close();
      }
    });
  }
}
