import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const harness = { source: "" };

test.beforeAll(() => {
  harness.source = execFileSync("bun", [
    "build",
    fileURLToPath(new URL("../src/handlers/visual-sandbox/browser/presentation.ts", import.meta.url)),
    "--target=browser",
    "--format=esm",
  ], { encoding: "utf-8" });
});

test("host themes override fallback tokens and replace one guest stylesheet", async ({ page }) => {
  await page.setContent('<html><head></head><body><p>Theme</p></body></html>');
  await page.addScriptTag({
    type: "module",
    content: `${harness.source}
      installVisualPresentation(document);
      applyVisualTheme(document, { appearance: "dark", variables: { "--foreground": "rgb(120, 130, 140)", "--radius": "9px" } });
      window.addEventListener("message", (event) => applyVisualTheme(document, event.data));
    `,
  });
  const theme = page.locator("head #stella-theme");
  await expect(theme).toHaveCount(1);
  await expect(page.locator("p")).toHaveCSS("color", "rgb(120, 130, 140)");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  expect(await page.evaluate(() => document.head.firstElementChild?.id)).toBe("stella-theme");
  await page.evaluate(() => {
    window.postMessage({ appearance: "light", variables: { "--foreground": "rgb(20, 30, 40)" } }, "*");
  });
  await expect(page.locator("p")).toHaveCSS("color", "rgb(20, 30, 40)");
  await expect(theme).toHaveCount(1);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
  // A live theme is a replacement: omitted variables recover their fallback.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--radius").trim())).toBe(".625rem");
});
