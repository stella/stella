import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { expect, test } from "../helpers/test";

const cache = path.resolve(import.meta.dirname, "../../.cache");
mkdirSync(cache, { recursive: true });
const directory = mkdtempSync(path.join(cache, "law-coverage-"));
let bundle = "";
let styles = "";
test.use({ storageState: { cookies: [], origins: [] } });
test.beforeAll(() => {
  const output = path.join(directory, "fixture.js");
  execFileSync(
    "bun",
    [
      "build",
      path.resolve(
        import.meta.dirname,
        "../../tests/fixtures/law-coverage.fixture.tsx",
      ),
      "--target=browser",
      "--minify",
      "--external=@tanstack/react-start/server",
      '--define=import.meta.env={"VITE_API_URL":"http://coverage.test","DEV":false}',
      '--define=process.env.NODE_ENV="production"',
      "--outfile",
      output,
    ],
    { maxBuffer: 2 ** 30, stdio: "pipe" },
  );
  bundle = readFileSync(output, "utf-8");
  writeFileSync(
    path.join(directory, "index.html"),
    '<!doctype html><link rel="stylesheet" href="../../src/styles/app.css">',
  );
  execFileSync(
    "bun",
    [
      "run",
      "--bun",
      "vite",
      "build",
      directory,
      "--config",
      path.resolve(
        import.meta.dirname,
        "../../../../packages/ui/vite.config.ts",
      ),
      "--outDir",
      "dist",
    ],
    { maxBuffer: 2 ** 30, stdio: "pipe" },
  );
  const assets = path.join(directory, "dist/assets");
  styles = readdirSync(assets)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(path.join(assets, file), "utf-8"))
    .join("\n");
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => {
  await page.route("**/law/coverage*", async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/coverage-fixture.css"></head><body><script type="importmap">{"imports":{"@tanstack/react-start/server":"/server-boundary.js"}}</script><script type="module" src="/coverage-fixture.js"></script></body></html>',
    }),
  );
  await page.route("**/coverage-fixture.css", async (route) =>
    route.fulfill({ contentType: "text/css", body: styles }),
  );
  await page.route("**/server-boundary.js", async (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "export const getRequestHost = () => location.host; export const getCookie = () => undefined; export const setCookie = () => { throw new Error('Server cookie writes are unavailable in this fixture'); };",
    }),
  );
  await page.route("**/coverage-fixture.js", async (route) =>
    route.fulfill({ contentType: "text/javascript", body: bundle }),
  );
});

for (const locale of ["en", "ar"]) {
  test(`country disclosures and anchors work with the keyboard (${locale})`, async ({
    page,
  }) => {
    await page.goto(`/law/coverage?locale=${locale}#country-svk`, {
      waitUntil: "domcontentloaded",
    });
    const country = page.locator("#country-cze");
    const toggle = country.locator("header button");
    const table = country.getByRole("table");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(table).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(table).toBeVisible();
    await page.keyboard.press("Space");
    const link = page.locator('nav a[href$="#country-cze"]');
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#country-cze$/u);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(table).toBeVisible();
    const completenessLabel = locale === "en" ? "Completeness" : "الاكتمال";
    const help = country
      .getByRole("columnheader", { name: completenessLabel, exact: true })
      .getByRole("button", { name: completenessLabel, exact: true });
    await help.focus();
    await expect(page.locator('[data-slot="tooltip-popup"]')).toBeVisible();
    await expect(page.locator('[data-slot="tooltip-popup"]')).toContainText(
      locale === "en" ? "publisher’s own count" : "الجهة الناشرة",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="tooltip-popup"]')).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar" ? "rtl" : "ltr",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const switcher = page.getByRole("combobox");
    await expect(switcher).toBeVisible();
    await toggle.focus();
    await page.keyboard.press("Space");
    await switcher.selectOption("country-svk");
    await expect(page).toHaveURL(/#country-svk$/u);
    await switcher.selectOption("country-cze");
    await expect(page).toHaveURL(/#country-cze$/u);
    await expect(table).toBeVisible();
    expect(
      await country
        .locator('[data-slot="table-container"]')
        .evaluateAll((nodes) =>
          nodes.every((node) => node.scrollWidth <= node.clientWidth),
        ),
    ).toBe(true);
    const navigationBottom = await page
      .locator("nav")
      .evaluate((node) => node.getBoundingClientRect().bottom);
    const countryTop = await country.evaluate(
      (node) => node.getBoundingClientRect().top,
    );
    expect(countryTop).toBeGreaterThanOrEqual(navigationBottom);
    expect(
      await page
        .locator("main")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  });
}
