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

test("long paste fixtures preserve composer expansion and sent preview", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      ["fetch", "xhr"].includes(request.resourceType()) &&
      /\/(?:chat|ai)(?:\/|$)/u.test(new URL(request.url()).pathname)
    ) {
      requests.push(request.url());
    }
  });
  await page.goto("/dev?visual=chat-long-paste", {
    waitUntil: "domcontentloaded",
  });
  const collapsed = page.locator(
    '[data-playground-section="chat-long-paste:draft-collapsed"]',
  );
  const expanded = page.locator(
    '[data-playground-section="chat-long-paste:draft-expanded"]',
  );
  const sent = page.locator(
    '[data-playground-section="chat-long-paste:sent-collapsed"]',
  );
  const sentExpanded = page.locator(
    '[data-playground-section="chat-long-paste:sent-expanded"]',
  );
  await expect(sentExpanded.locator("pre")).toBeVisible();
  await expect(sentExpanded.locator("button[aria-expanded]")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const title = "Lease review: maintenance and notice provisions";
  await expect(collapsed.getByRole("textbox")).toHaveText(
    "Review the maintenance obligations in this lease.",
  );
  await expect(
    collapsed.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  await expect(expanded.getByRole("textbox")).toContainText("Clause 22:");
  await expect(
    expanded.getByRole("button", { name: title, exact: true }),
  ).toHaveCount(0);

  const preview = sent.locator("pre");
  const disclosure = sent.locator("button[aria-expanded]");
  await expect(preview).toBeHidden();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  const text = await preview.textContent();
  expect(text).toContain("Clause 22:");
  await disclosure.click();
  await expect(preview).toBeVisible();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(preview).toHaveText(text ?? "");

  await collapsed
    .getByRole("button", { name: title, exact: true })
    .locator("..")
    .locator("button[title]")
    .first()
    .click();
  await expect(
    collapsed.getByRole("button", { name: title, exact: true }),
  ).toHaveCount(0);
  await expect(collapsed.getByRole("textbox")).toContainText("Clause 22:");
  expect(requests).toEqual([]);
});
