import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import * as v from "valibot";

import {
  GENERATED_VISUAL_MIME_TYPE,
  GENERATED_VISUAL_URI_PREFIX,
  generatedVisualPageSchema,
  generatedVisualPartSchema,
} from "@stll/api-contract/generated-visual";
import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";
import { VISUAL_SANDBOX_LIMITS } from "@stll/api-contract/visual-sandbox";

import showcase from "../../api/src/handlers/visual-sandbox/fixtures/showcase/court-year-showcase.json" with { type: "json" };
import { PALETTE_STORAGE_KEY, THEME_STORAGE_KEY } from "../src/consts";
import { installDockedChatHistory } from "./helpers/docked-chat-fixtures";
import { dockedChatMessagePage } from "./helpers/docked-chat-history";

type VisualDesignCaptureContext = {
  page: Page;
  webUrl: string;
  snap: (label: string, options?: { waitFor?: string }) => Promise<void>;
};

const captureVisualDesign = async ({
  page,
  webUrl,
  snap,
}: VisualDesignCaptureContext) => {
  const threadId = "019a0000-0000-7000-8000-000000000001";
  const fileId = "019a0000-0000-7000-8000-000000000003";
  const visual = v.parse(generatedVisualPageSchema, {
    ...showcase,
    html: await readFile(
      new URL(
        "../../api/src/handlers/visual-sandbox/fixtures/showcase/court-year-showcase.html",
        import.meta.url,
      ),
      "utf-8",
    ),
  });
  const part = v.parse(generatedVisualPartSchema, {
    type: "ui-resource",
    resource: {
      uri: `${GENERATED_VISUAL_URI_PREFIX}${fileId}`,
      mimeType: GENERATED_VISUAL_MIME_TYPE,
      text: visual.title,
    },
    toolCallId: "visual-design-capture",
    toolName: VISUAL_PREVIEW_TOOL_NAME,
  });
  await installDockedChatHistory(page);
  await page.route("**/v1/chat/threads/*/messages*", async (route) => {
    await route.fulfill({
      json: {
        ...dockedChatMessagePage,
        messages: [
          {
            id: "019a0000-0000-7000-8000-000000000002",
            role: "assistant",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [part],
          },
        ],
      },
    });
  });
  await page.route(`**/v1/user-files/${fileId}/visual`, async (route) => {
    await route.fulfill({
      json: visual,
      headers: { "cache-control": "private, no-store" },
    });
  });
  await page.addInitScript(
    ({ themeKey, paletteKey }) => {
      if (window === window.top) {
        localStorage.setItem(themeKey, "light");
        localStorage.setItem(paletteKey, "neutral");
      }
    },
    { themeKey: THEME_STORAGE_KEY, paletteKey: PALETTE_STORAGE_KEY },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${webUrl}/chat/${threadId}`, { waitUntil: "commit" });
  const selector = `iframe[title="${visual.title}"]`;
  const outer = page.locator(selector);
  const guest = page.frameLocator(selector).frameLocator("iframe");
  const caption = outer.locator("xpath=ancestor::section[1]").locator("header");
  const chart = guest.locator("#chart");
  const chartViewportRatio = async () => {
    const bounds = await chart.boundingBox();
    const viewport = page.viewportSize();
    if (!bounds || !viewport) {
      return 0;
    }
    // boundingBox uses the host page's coordinates, including nested frames.
    const width = Math.max(
      0,
      Math.min(bounds.x + bounds.width, viewport.width) - Math.max(bounds.x, 0),
    );
    const height = Math.max(
      0,
      Math.min(bounds.y + bounds.height, viewport.height) -
        Math.max(bounds.y, 0),
    );
    return (width * height) / (bounds.width * bounds.height);
  };
  const prepareCapture = async () => {
    await guest.locator("html").evaluate(async () => {
      await document.fonts.ready;
    });
    await expect
      .poll(async () => {
        const contentHeight = await guest
          .locator("html")
          .evaluate((element) => element.scrollHeight);
        const frameHeight = await outer.evaluate(
          (element) => element.getBoundingClientRect().height,
        );
        return (
          Math.min(contentHeight, VISUAL_SANDBOX_LIMITS.height) <=
          frameHeight + 1
        );
      })
      .toBe(true);
    const tokens = ["--foreground", "--border", "--chart-1"];
    const hostTokens = await page.locator("html").evaluate((element, names) => {
      const style = getComputedStyle(element);
      return names.map((name) => style.getPropertyValue(name).trim());
    }, tokens);
    await expect
      .poll(() =>
        guest.locator("html").evaluate((element, names) => {
          const style = getComputedStyle(element);
          return names.map((name) => style.getPropertyValue(name).trim());
        }, tokens),
      )
      .toEqual(hostTokens);
    await caption.evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "instant" }),
    );
    await expect(caption).toBeInViewport({ ratio: 1 });
  };
  await expect(
    guest.locator("#chart").locator("svg, canvas").first(),
  ).toBeVisible();
  await expect(guest.locator("#ranking .stella-button")).toHaveCount(
    showcase.data.topResults.length,
  );
  await expect(guest.locator("html")).toHaveCSS("color-scheme", "light");
  await prepareCapture();
  await expect.poll(chartViewportRatio).toBeGreaterThanOrEqual(0.25);
  await snap("visual-design-light-desktop", { waitFor: selector });

  // Change the preference in place: the existing chart must repaint without
  // replacing either sandbox document or resetting its selected court.
  const initialSrc = await outer.getAttribute("src");
  await page.evaluate((key) => {
    localStorage.setItem(key, "dark");
    window.dispatchEvent(new Event("stella-theme-preference-change"));
  }, THEME_STORAGE_KEY);
  await expect(guest.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(outer).toHaveAttribute("src", initialSrc ?? "");
  await prepareCapture();
  await expect.poll(chartViewportRatio).toBeGreaterThanOrEqual(0.25);
  await snap("visual-design-dark-desktop", { waitFor: selector });

  await page.evaluate((key) => {
    localStorage.setItem(key, "light");
    window.dispatchEvent(new Event("stella-theme-preference-change"));
  }, THEME_STORAGE_KEY);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guest.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(
    guest.locator("#chart").locator("svg, canvas").first(),
  ).toBeVisible();
  await prepareCapture();
  await snap("visual-design-light-mobile", { waitFor: selector });
  // The wrapping statistics can put the chart below the mobile overview.
  // Capture its own viewport as well so the palette and labels are reviewable.
  const chartOffset = await chart.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const positionedChart = await outer.evaluate((element, offset) => {
    const viewport = element.closest('[data-slot="scroll-area-viewport"]');
    if (viewport === null) {
      return false;
    }
    viewport.scrollTop +=
      element.getBoundingClientRect().top +
      offset -
      viewport.getBoundingClientRect().top -
      16;
    return true;
  }, chartOffset);
  expect(positionedChart).toBe(true);
  await expect.poll(chartViewportRatio).toBeGreaterThanOrEqual(0.6);
  await snap("visual-design-light-mobile-chart", { waitFor: selector });
};

export default captureVisualDesign;
