import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../helpers/test";

// "/" opens the Skills list as a standalone popup, not as the (+) root menu
// with a submenu forced open: a shortcut leaves the pointer wherever the caret
// was, usually under a sibling root item, and Base UI closes an open submenu
// the moment the pointer moves over a sibling. With no siblings rendered, the
// first nudge of the mouse has nothing to switch to.
test("the slash shortcut opens a Skills popup that survives pointer movement", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.getByRole("textbox", { name: /type your question/iu });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.click();
  await page.keyboard.press("/");

  const skillsSearch = page.getByRole("textbox", { name: "Search skills" });
  await expect(skillsSearch).toBeVisible();
  await expect(skillsSearch).toBeFocused();
  const rootMenu = page.getByRole("menu", {
    name: "Open attachments and tools menu",
  });
  await expect(rootMenu).not.toBeVisible();

  // Anchored to the (+) button like the root menu it replaces (start-aligned;
  // which side it lands on depends on the viewport's free space).
  const plusButton = page.getByRole("button", {
    name: "Open attachments and tools menu",
  });
  const popup = page.getByRole("menu", { name: "Skills" });
  const [popupBox, buttonBox] = await Promise.all([
    popup.boundingBox(),
    plusButton.boundingBox(),
  ]);
  if (!popupBox || !buttonBox) {
    throw new Error("Skills popup or (+) button is not laid out");
  }
  expect(Math.abs(popupBox.x - buttonBox.x)).toBeLessThanOrEqual(2);

  // Sweep the pointer across where the root menu's items would sit and into
  // the popup; Base UI's hover timers are 100ms, so wait past them.
  await walkPointer(page, plusButton, popup);
  await page.waitForTimeout(400);
  await expect(skillsSearch).toBeVisible();
  await expect(rootMenu).not.toBeVisible();

  await page.keyboard.press("Escape");
  await expect(skillsSearch).not.toBeVisible();
  await expect(composer).toBeFocused();

  // A session the pointer started keeps hover-driven submenus.
  await plusButton.click();
  await expect(rootMenu).toBeVisible();
  const contextTrigger = page.getByRole("menuitem", { name: "Context" });
  await hoverWithMovement(page, contextTrigger);
  await expect(
    page.getByRole("textbox", { name: "Search matters" }),
  ).toBeVisible();
});

const centerOf = async (target: Locator) => {
  const box = await target.boundingBox();
  if (!box) {
    throw new Error("Element is not laid out");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

// A single teleporting `hover()` never trips Base UI's "the pointer really
// moved" gate, so walk the mouse onto the trigger the way a hand would.
const hoverWithMovement = async (page: Page, target: Locator) => {
  const { x, y } = await centerOf(target);
  await page.mouse.move(x - 6, y - 4, { steps: 4 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.move(x + 3, y + 1, { steps: 2 });
};

// From the (+) button up through the band the root menu would occupy, then
// across into the popup.
const walkPointer = async (page: Page, from: Locator, to: Locator) => {
  const start = await centerOf(from);
  const end = await centerOf(to);
  await page.mouse.move(start.x, start.y, { steps: 3 });
  await page.mouse.move(start.x + 40, start.y - 60, { steps: 8 });
  await page.mouse.move(start.x + 80, start.y - 90, { steps: 8 });
  await page.mouse.move(end.x, end.y, { steps: 10 });
};

test("the at-sign shortcut opens a Context popup and hands focus back on Escape", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "commit" });
  const composer = page.getByRole("textbox", { name: /type your question/iu });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.click();
  await page.keyboard.press("@");

  const mattersSearch = page.getByRole("textbox", { name: "Search matters" });
  await expect(mattersSearch).toBeVisible();
  await expect(mattersSearch).toBeFocused();
  await expect(
    page.getByRole("menu", { name: "Open attachments and tools menu" }),
  ).not.toBeVisible();

  await page.keyboard.press("Escape");
  await expect(mattersSearch).not.toBeVisible();
  await expect(composer).toBeFocused();
});
