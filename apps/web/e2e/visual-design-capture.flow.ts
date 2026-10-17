import { expect, type Locator, type Page } from "@playwright/test";
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

import { installDockedChatHistory } from "./helpers/docked-chat-fixtures";
import { dockedChatMessagePage } from "./helpers/docked-chat-history";
import { setPresentationPrefs } from "./helpers/presentation-prefs";

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
  // The API showcase test keeps this prepared page in sync with the
  // sanitizer, so the capture renders exactly what the API would serve.
  const visual = v.parse(
    generatedVisualPageSchema,
    JSON.parse(
      await readFile(
        new URL(
          "../../api/src/handlers/visual-sandbox/fixtures/showcase/court-year-showcase.prepared.json",
          import.meta.url,
        ),
        "utf-8",
      ),
    ),
  );
  const topResultCount = v.parse(
    v.object({ topResults: v.array(v.unknown()) }),
    visual.data,
  ).topResults.length;
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
  await setPresentationPrefs({
    context: page.context(),
    url: webUrl,
    patch: { theme: "light", palette: "neutral" },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${webUrl}/chat/${threadId}`, { waitUntil: "commit" });
  const selector = `iframe[title="${visual.title}"]`;
  const outer = page.locator(selector);
  await expect(outer).toBeVisible({ timeout: 120_000 });
  const guest = page.frameLocator(selector).frameLocator("iframe");
  const caption = outer.locator("xpath=ancestor::section[1]").locator("header");
  const chart = guest.locator("#chart");
  const viewportRatio = async (locator: Locator) => {
    const bounds = await locator.boundingBox();
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
  const alignGuestSection = async (sectionSelector: string) => {
    const offset = await guest
      .locator(sectionSelector)
      .evaluate((element) => element.getBoundingClientRect().top);
    const positioned = await outer.evaluate((element, sectionOffset) => {
      const viewport = element.closest('[data-slot="scroll-area-viewport"]');
      if (viewport === null) {
        return false;
      }
      viewport.scrollTop +=
        element.getBoundingClientRect().top +
        sectionOffset -
        viewport.getBoundingClientRect().top -
        16;
      return true;
    }, offset);
    expect(positioned, "generated view has a host scroll viewport").toBe(true);
  };
  const prepareCapture = async () => {
    await expect
      .poll(
        async () =>
          outer.evaluate((element) => {
            const section = element.closest("section");
            const message = element.closest("[data-chat-message-id]");
            if (section === null || message === null) {
              return false;
            }
            return (
              Math.abs(
                section.getBoundingClientRect().width -
                  message.getBoundingClientRect().width,
              ) <= 1
            );
          }),
        { message: "generated view fills the chat content column" },
      )
      .toBe(true);
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
      .poll(async () =>
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
    topResultCount,
  );
  await expect(guest.locator("html")).toHaveCSS("color-scheme", "light");
  await prepareCapture();
  const assertLegibleLabels = async () => {
    const labels = chart.locator("svg text");
    expect(
      await labels.count(),
      "desktop treemap renders labels",
    ).toBeGreaterThan(0);
    expect(
      await labels.evaluateAll((elements) =>
        elements.every(
          (element) =>
            Number.parseFloat(getComputedStyle(element).fontSize) >= 14,
        ),
      ),
      "treemap labels are at least 14 CSS pixels",
    ).toBe(true);
  };
  await assertLegibleLabels();
  await expect
    .poll(async () => viewportRatio(chart))
    .toBeGreaterThanOrEqual(0.25);
  await snap("visual-design-light-desktop", { waitFor: selector });

  // Change the preference in place: the existing chart must repaint without
  // replacing either sandbox document or resetting its selected court.
  const initialSrc = await outer.getAttribute("src");
  const accountMenu = page
    .locator('[data-slot="sidebar-footer"] button[aria-haspopup="menu"]')
    .last();
  await accountMenu.click();
  await page.getByRole("menuitem", { name: /appearance|vzhled/iu }).hover();
  await page.getByRole("menuitemradio", { name: /dark|tmavý/iu }).click();
  // Theme radio choices keep the menu open so further preferences can change.
  await accountMenu.click();
  await expect(accountMenu).toHaveAttribute("aria-expanded", "false");
  await expect(guest.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(outer).toHaveAttribute("src", initialSrc ?? "");
  await prepareCapture();
  await assertLegibleLabels();
  await expect
    .poll(async () => viewportRatio(chart))
    .toBeGreaterThanOrEqual(0.25);
  await snap("visual-design-dark-desktop", { waitFor: selector });

  await accountMenu.click();
  await page.getByRole("menuitem", { name: /appearance|vzhled/iu }).hover();
  await page.getByRole("menuitemradio", { name: /light|světlý/iu }).click();
  await accountMenu.click();
  await expect(accountMenu).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guest.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(
    guest.locator("#chart").locator("svg, canvas").first(),
  ).toBeVisible();
  await prepareCapture();
  for (const root of [
    page.locator("html"),
    page.frameLocator(selector).locator("html"),
    guest.locator("html"),
  ]) {
    await expect
      .poll(
        async () =>
          root.evaluate((element) => element.scrollWidth - element.clientWidth),
        { message: "mobile generated view has no horizontal overflow" },
      )
      .toBeLessThanOrEqual(1);
  }
  await expect
    .poll(
      async () => {
        const bounds = await chart.boundingBox();
        const frameBounds = await outer.boundingBox();
        const viewport = page.viewportSize();
        return (
          bounds !== null &&
          frameBounds !== null &&
          viewport !== null &&
          bounds.x >= frameBounds.x - 1 &&
          bounds.x + bounds.width <= frameBounds.x + frameBounds.width + 1 &&
          bounds.x >= -1 &&
          bounds.x + bounds.width <= viewport.width + 1
        );
      },
      { message: "mobile chart fits inside its frame and the host viewport" },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        chart.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const tiles = Array.from(element.querySelectorAll("svg rect"));
          return (
            tiles.length > 0 &&
            tiles.every((tile) => {
              const tileBounds = tile.getBoundingClientRect();
              return (
                tileBounds.left >= bounds.left - 1 &&
                tileBounds.right <= bounds.right + 1
              );
            })
          );
        }),
      { message: "every mobile treemap tile fits the chart" },
    )
    .toBe(true);
  await snap("visual-design-light-mobile", { waitFor: selector });
  // The wrapping statistics can put the chart below the mobile overview.
  // Capture its own viewport as well so the palette and labels are reviewable.
  await alignGuestSection("#chart");
  await expect
    .poll(async () => viewportRatio(chart))
    .toBeGreaterThanOrEqual(0.6);
  await snap("visual-design-light-mobile-chart", { waitFor: selector });
  await alignGuestSection("#ranking");
  const firstRankingButton = guest.locator("#ranking .stella-button").first();
  await expect
    .poll(async () => viewportRatio(firstRankingButton))
    .toBeGreaterThanOrEqual(0.6);
  await snap("visual-design-light-mobile-ranking", { waitFor: selector });

  const transcript = page
    .getByRole("log")
    .locator('[data-slot="scroll-area-viewport"]');
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator("[data-chat-bottom-fade]")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 2400 });
  await expect
    .poll(async () =>
      transcript.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect(page.locator("[data-chat-bottom-fade]")).toBeHidden();
};

export default captureVisualDesign;
