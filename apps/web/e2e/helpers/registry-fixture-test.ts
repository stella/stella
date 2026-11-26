import type { Page } from "@playwright/test";

import { findControlsOverText } from "./control-over-text";
import { findEscapedText } from "./escaped-text";
import { expect, waitForStableGeometry } from "./stable-geometry";

export const expectRegisteredVisualFixture = async (
  page: Page,
  url: string,
  name: string,
  label: string,
) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const section = page.locator(`[data-playground-section="fixture:${name}"]`);
  await expect(section).toBeVisible();
  await expect(section.locator("header").first()).toHaveText(
    `Fixture: ${label}`,
  );
  // The label renders before the lazy component; require its actual content
  // too so a broken loader cannot satisfy the registry census.
  await expect(section.locator(":scope > :not(header)").first()).toBeVisible();
  await waitForStableGeometry(page, section);
  // Polled: a scripted fixture (a turn that streams on a timer) may change
  // between two reads; a leak that stays is still caught.
  await expect
    .poll(async () => await findEscapedText(section), {
      message: `${name} must keep every text inside its box`,
    })
    .toEqual([]);
  expect(
    await findControlsOverText(section),
    `${name} must keep every control off a textbox's text`,
  ).toEqual([]);
  if (name === "mcp-reconnect") {
    // Require the real notice, including the approval-only connection,
    // rather than accepting an empty fixture wrapper.
    const notice = section.locator('[data-playground-section="mcp-reconnect"]');
    await expect(notice.locator("span > bdi")).toHaveText([
      "Registry Search",
      "Document Archive",
    ]);
    await expect(notice.getByRole("button")).toHaveCount(2);
    await expect(notice.getByRole("button").first()).toBeVisible();
    await expect(notice.getByRole("button").last()).toBeVisible();
  }
  if (name === "chat-history-decision") {
    // The fixtures stay out of this spec: they are typed against the web
    // API routes, which would pull the app's types into the browser tests.
    const rows = await section.locator("[data-playground-state]").all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      await expect(row).toBeVisible();
      const fitsRow = await row.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      );
      expect(fitsRow).toBe(true);
    }
  }
  const sharesPageScrollFlow = await section.evaluate((fixture) => {
    const main = fixture.closest("main");
    const header = fixture.querySelector("header");
    if (!(main instanceof HTMLElement) || header === null) {
      return false;
    }
    if (header.closest("main") !== main) {
      return false;
    }
    const overflowY = getComputedStyle(main).overflowY;
    return overflowY === "auto" || overflowY === "scroll";
  });
  expect(sharesPageScrollFlow).toBe(true);
  expect(errors).toEqual([]);
};
