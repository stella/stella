import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { VISUAL_SANDBOX_PATH } from "@stll/api-contract/visual-sandbox";

import type * as TreemapHelpers from "./visual-treemap.helpers";

const E2E_API_ORIGIN = process.env["E2E_API_URL"] ?? "http://localhost:3001";

const runtime = readFileSync(
  new URL(
    "../src/handlers/visual-sandbox/generated/runtime.js.txt",
    import.meta.url,
  ),
  "utf-8",
);

const harness = { source: "" };
const loaded: { helpers?: typeof TreemapHelpers } = {};
const helpers = (): typeof TreemapHelpers => {
  if (!loaded.helpers) {
    throw new TypeError("Treemap helpers load in beforeAll");
  }
  return loaded.helpers;
};

test.beforeAll(async () => {
  const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-treemap-"));
  const helpersBundle = path.join(bundleDir, "helpers.mjs");
  execFileSync("bun", [
    "build",
    fileURLToPath(new URL("visual-treemap.helpers.ts", import.meta.url)),
    "--target=node",
    "--format=esm",
    `--outfile=${helpersBundle}`,
  ]);
  loaded.helpers = (await import(
    pathToFileURL(helpersBundle).href
  )) as typeof TreemapHelpers;
  rmSync(bundleDir, { force: true, recursive: true });
  harness.source = execFileSync(
    "bun",
    [
      "build",
      fileURLToPath(
        new URL(
          "../src/handlers/visual-sandbox/browser/treemap.harness.ts",
          import.meta.url,
        ),
      ),
      "--minify",
      "--target=browser",
      "--format=iife",
    ],
    { encoding: "utf-8" },
  );
});

for (const direction of ["ltr", "rtl"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`visual treemap renders, drills and changes color in ${direction}/${colorScheme} without requests`, async ({
      page,
      request,
    }) => {
      const {
        composeVisualDocument,
        courtTierLabelsForLanguage,
        escapeVisualJson,
        sanitizeVisualHtml,
        treemapFixture,
      } = helpers();
      const requests: string[] = [];
      const errors: string[] = [];
      page.on("request", (networkRequest) =>
        requests.push(networkRequest.url()),
      );
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          errors.push(message.text());
        }
      });
      const response = await request.get(
        new URL(VISUAL_SANDBOX_PATH, E2E_API_ORIGIN).href,
      );
      expect(response.status()).toBe(200);
      const policy = response.headers()["content-security-policy"];
      expect(policy).toBeDefined();
      if (!policy) {
        throw new TypeError("Sandbox response requires a policy");
      }
      const html = sanitizeVisualHtml(
        `<div dir="${direction}" lang="cs" id="chart" style="width:900px"></div><button id="color">Barva</button><button id="citations">Citace</button><button id="category">Kategorie</button><button id="empty">Prázdný strom</button><button id="destroy">Zavřít</button><script>document.documentElement.dir=${escapeVisualJson(direction)};document.documentElement.lang="cs";${harness.source}</script>`,
      ).unwrap();
      const document = composeVisualDocument({
        html,
        data: {},
        runtime,
        policy: policy
          .split(";")
          .filter(
            (directive) => !directive.trim().startsWith("frame-ancestors"),
          )
          .join(";"),
      });
      await page.emulateMedia({ colorScheme });
      await page.setContent(
        `<iframe title="Treemap" sandbox="allow-scripts" style="width:1000px;height:800px"></iframe>`,
      );
      await page.locator("iframe").evaluate((iframe, srcdoc) => {
        // safe-html: composeVisualDocument combines sanitizeVisualHtml output, the bundled runtime and the real sandbox policy.
        iframe.setAttribute("srcdoc", srcdoc);
      }, document);
      const guest = page.frameLocator("iframe");
      const svg = guest.locator("svg").first();
      await expect(svg).toHaveAttribute("aria-label", treemapFixture.label);
      // Theme tokens resolve through light-dark(), so the inherited text
      // colour proves which scheme the chart rendered in.
      await expect(svg).toHaveCSS(
        "color",
        colorScheme === "dark" ? "rgb(245, 245, 245)" : "rgb(38, 38, 38)",
      );
      await expect(svg.locator("text")).toContainText([
        "Nejvyšší soud",
        "Ústavní soud",
      ]);
      await svg.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect(svg).toHaveAttribute(
        "aria-label",
        /Nejvyšší soud|Ústavní soud/u,
      );
      await page.keyboard.press("Escape");
      await expect(svg).toHaveAttribute("aria-label", treemapFixture.label);
      await svg.locator("text").filter({ hasText: "Nejvyšší soud" }).click();
      await expect(svg).toHaveAttribute("aria-label", "Nejvyšší soud");
      await svg.locator("text").filter({ hasText: "2024" }).click();
      await expect(guest.locator("#chart")).toHaveAttribute(
        "data-selected",
        "CZ:ns:2024",
      );
      await svg.click({ button: "right" });
      await expect(svg).toHaveAttribute("aria-label", treemapFixture.label);
      await expect(guest.locator('[data-color-mode="category"]')).toContainText(
        "Ústavní soudy",
      );
      const cellFills = async () =>
        svg
          .locator('rect[fill]:not([data-ts-key="background"])')
          .evaluateAll((cells) =>
            cells.map((cell) => cell.getAttribute("fill")),
          );
      const initialFill = await cellFills();
      const categoryFills = new Map<string, string>();
      for (const court of treemapFixture.children) {
        const fill = await svg
          .locator("text")
          .filter({ hasText: court.label })
          .evaluate((label) => {
            const cellKey = label.dataset["tsKey"]?.replace(/:label$/u, "");
            const cell = Array.from(
              label.closest("svg")?.querySelectorAll("rect") ?? [],
            ).find((candidate) => candidate.dataset["tsKey"] === cellKey);
            return cell ? getComputedStyle(cell).fill : undefined;
          });
        expect(fill).toBeTruthy();
        if (!fill) {
          throw new TypeError("Court category requires a rendered cell fill");
        }
        const swatch = guest
          .locator('[data-color-mode="category"] > span')
          .filter({ hasText: courtTierLabelsForLanguage("cs")[court.tier] })
          .locator("span");
        expect(
          await swatch.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          ),
        ).toBe(fill);
        const existingFill = categoryFills.get(court.tier);
        if (existingFill !== undefined) {
          expect(fill).toBe(existingFill);
        }
        categoryFills.set(court.tier, fill);
      }
      expect(new Set(categoryFills.values()).size).toBe(categoryFills.size);
      await guest.locator("#color").click();
      await expect(guest.locator('[data-color-mode="treatment"]')).toHaveText(
        "——",
      );
      expect(await cellFills()).not.toEqual(initialFill);
      await guest.locator("#citations").click();
      await expect(guest.locator('[data-color-mode="citations"]')).toHaveText(
        "076",
      );
      await guest.locator("#category").click();
      await expect(guest.locator('[data-color-mode="category"]')).toContainText(
        "Ústavní soudy",
      );
      await guest.locator("#empty").click();
      await expect(svg).toHaveAttribute("aria-label", "empty-root");
      await svg.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      await svg.click({ position: { x: 100, y: 100 } });
      await expect(svg).toHaveAttribute("aria-label", "empty-root");
      await expect(guest.locator("#chart")).not.toHaveAttribute(
        "data-selected",
      );
      await guest.locator("#destroy").click();
      await expect(guest.locator("#chart")).toBeEmpty();
      expect(requests).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
