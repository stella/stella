/**
 * An answer's footer holds its actions and the "Also consulted" disclosure on
 * one row.
 *
 * The bench at `/dev?visual=chat-answer-footer` renders a finished turn through
 * the real transcript. The disclosure's trigger stays in the row and its
 * sources open across the row's full width below it, so opening them moves
 * nothing a reader is pointing at.
 */

import {
  expect,
  expectGeometry,
  stableBoundingBox,
  test,
} from "../helpers/stable-geometry";

// Items of one row share a vertical centre; subpixel layout can split it.
const EPSILON_PX = 1;

test("the answer footer keeps its actions and consulted sources on one row", async ({
  page,
}) => {
  await page.goto("/dev?visual=chat-answer-footer", {
    waitUntil: "domcontentloaded",
  });
  const footer = page.locator("[data-chat-answer-footer]").last();
  const trigger = footer.getByRole("button", { name: /Also consulted/u });
  await expect(trigger).toBeVisible();

  const centre = async (selector: string) => {
    const box = await stableBoundingBox(page, footer.locator(selector).first());
    return box.y + box.height / 2;
  };
  const actions = await centre("[data-chat-answer-actions]");
  const duration = await centre("[data-chat-turn-duration]");
  const closed = await stableBoundingBox(page, trigger);
  expectGeometry(duration, actions, EPSILON_PX);
  expectGeometry(closed.y + closed.height / 2, actions, EPSILON_PX);
  await expect(
    footer.locator("[data-chat-answer-citations-divider]"),
  ).toBeVisible();

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const panel = footer.locator('[data-slot="collapsible-panel"]');
  await expect(panel).toBeVisible();

  const opened = await stableBoundingBox(page, trigger);
  const panelBox = await stableBoundingBox(page, panel);
  const footerBox = await stableBoundingBox(page, footer);
  expectGeometry(opened.y, closed.y, EPSILON_PX);
  expect(panelBox.y).toBeGreaterThan(opened.y + opened.height - EPSILON_PX);
  expectGeometry(panelBox.width, footerBox.width, EPSILON_PX);
});
