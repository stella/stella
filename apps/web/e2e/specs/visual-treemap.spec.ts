import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { VISUAL_SANDBOX_PATH } from "@stll/api-contract/visual-sandbox";

import { treemapFixture } from "../../../api/src/handlers/visual-sandbox/browser/treemap-fixture";
import { sanitizeVisualHtml } from "../../../api/src/handlers/visual-sandbox/sanitize";
import {
  composeVisualDocument,
  escapeVisualJson,
} from "../../../api/src/handlers/visual-sandbox/srcdoc";
import { E2E_API_ORIGIN } from "../helpers/api";

const runtime = readFileSync(
  new URL(
    "../../../api/src/handlers/visual-sandbox/generated/runtime.js.txt",
    import.meta.url,
  ),
  "utf-8",
);

const harness = execFileSync(
  "bun",
  [
    "build",
    new URL(
      "../../../api/src/handlers/visual-sandbox/browser/treemap.harness.ts",
      import.meta.url,
    ).pathname,
    "--minify",
    "--target=browser",
    "--format=iife",
  ],
  { encoding: "utf-8" },
);

for (const direction of ["ltr", "rtl"] as const) {
  test(`visual treemap renders, drills and changes color in ${direction} without requests`, async ({
    page,
    request,
  }) => {
    const requests: string[] = [];
    const errors: string[] = [];
    page.on("request", (networkRequest) => requests.push(networkRequest.url()));
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
      `<div dir="${direction}" lang="cs" id="chart" style="width:900px"></div><button id="color">Barva</button><button id="citations">Citace</button><button id="category">Kategorie</button><button id="destroy">Zavřít</button><script>document.documentElement.dir=${escapeVisualJson(direction)};document.documentElement.lang="cs";${harness}</script>`,
    ).unwrap();
    const document = composeVisualDocument({
      html,
      runtime,
      policy: policy
        .split(";")
        .filter((directive) => !directive.trim().startsWith("frame-ancestors"))
        .join(";"),
    });
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
    const cellFills = () =>
      svg
        .locator('rect[fill]:not([data-ts-key="background"])')
        .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("fill")));
    const initialFill = await cellFills();
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
    await guest.locator("#destroy").click();
    await expect(guest.locator("#chart")).toBeEmpty();
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
