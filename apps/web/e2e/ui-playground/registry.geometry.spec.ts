import { expect, test } from "@playwright/test";

import {
  playbookEditorStates,
  visualRegistry,
} from "../../src/routes/dev/-visual-metadata";

for (const [name, { label }] of Object.entries(visualRegistry)) {
  test(`renders the registered ${name} fixture with its label`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/dev?visual=${name}`, { waitUntil: "domcontentloaded" });

    const section = page.locator(`[data-playground-section="fixture:${name}"]`);
    await expect(section).toBeVisible();
    await expect(section.locator("header").first()).toHaveText(
      `Fixture: ${label}`,
    );
    // The label renders before the lazy component; require its actual content
    // too so a broken loader cannot satisfy the registry census.
    await expect(
      section.locator(":scope > :not(header)").first(),
    ).toBeVisible();
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
  });
}

test("renders retained playbook edits and rejected-save recovery at stable anchors", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      ["fetch", "xhr"].includes(request.resourceType()) &&
      new URL(request.url()).pathname.includes("/playbooks")
    ) {
      requests.push(request.url());
    }
  });
  await page.goto("/dev?visual=playbook-editor", {
    waitUntil: "domcontentloaded",
  });
  for (const state of playbookEditorStates) {
    const section = page.locator(
      `[data-playground-section="playbook-editor:${state}"]`,
    );
    await expect(section).toBeVisible();
    await expect(section.locator("input").first()).toHaveValue(
      "Contract review",
    );
    await expect(section.locator("textarea").first()).toHaveValue(
      `${state}: retain the negotiated liability cap`,
    );
    await expect(section.locator("[inert]")).toBeVisible();
  }
  const rejected = page.locator(
    '[data-playground-section="playbook-editor:rejected"]',
  );
  await expect(rejected.locator(".text-destructive")).toBeVisible();
  await expect(
    rejected.locator("button").filter({ hasText: /Retry|إعادة المحاولة/u }),
  ).toBeVisible();
  expect(requests).toEqual([]);
});
