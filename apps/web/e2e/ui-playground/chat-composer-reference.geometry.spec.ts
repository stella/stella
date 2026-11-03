/**
 * A reference chip never makes the chat composer scroll sideways.
 *
 * The bench at `/dev?visual=chat-composer-reference` mounts the product's
 * composer at 300px, the width of a docked chat panel, with a document
 * mention whose name is wider than the editor. Every project runs this, so
 * it is measured under `ar` (RTL) as well.
 */

import { composerReferenceStates } from "../../src/routes/dev/-visual-metadata";
import {
  expect,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

const CHIP = '[data-chip-kind="reference"]';
// Subpixel layout can put an edge a fraction past its container.
const EPSILON_PX = 0.5;

for (const state of composerReferenceStates) {
  test(`the ${state} composer keeps its reference chip inside the editor`, async ({
    page,
  }) => {
    await page.goto("/dev?visual=chat-composer-reference", {
      waitUntil: "domcontentloaded",
    });
    const section = page.locator(
      `[data-playground-section="chat-composer-reference:${state}"]`,
    );
    const editor = section.getByRole("textbox");
    const chip = section.locator(CHIP);
    await expect(chip).toBeVisible();
    await waitForStableGeometry(page, section);

    const geometry = await editor.evaluate((element, selector) => {
      const pill = element.querySelector(selector);
      if (!(pill instanceof HTMLElement)) {
        throw new Error("The composer rendered no reference chip.");
      }
      const box = element.getBoundingClientRect();
      const chipBox = pill.getBoundingClientRect();
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        editor: { left: box.left, right: box.right },
        chip: { left: chipBox.left, right: chipBox.right },
      };
    }, CHIP);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(geometry.chip.left).toBeGreaterThanOrEqual(
      geometry.editor.left - EPSILON_PX,
    );
    expect(geometry.chip.right).toBeLessThanOrEqual(
      geometry.editor.right + EPSILON_PX,
    );

    // The visible label may be cut; the full name stays the chip's title,
    // which is also its accessible name.
    const label = await chip.locator("bdi").textContent();
    await expect(chip).toHaveAttribute("title", label ?? "");
  });
}

// A chip clamped to the line still leaves room for the space and caret after
// it, so typing continues beside the chip rather than on a line of its own.
for (const state of ["compact-long", "compact-short"] as const) {
  test(`the caret stays on the ${state} reference chip's line`, async ({
    page,
  }) => {
    await page.goto("/dev?visual=chat-composer-reference", {
      waitUntil: "domcontentloaded",
    });
    const section = page.locator(
      `[data-playground-section="chat-composer-reference:${state}"]`,
    );
    const editor = section.getByRole("textbox");
    await expect(section.locator(CHIP)).toBeVisible();
    await waitForStableGeometry(page, section);

    const lines = await editor.evaluate((element, selector) => {
      const pill = element.querySelector(selector);
      // A collapsed range at a line end reports an empty box, so measure the
      // space the caret follows: the last character of the draft.
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        if (node instanceof Text) {
          last = node;
        }
      }
      if (
        !(pill instanceof HTMLElement) ||
        last === null ||
        pill.contains(last)
      ) {
        throw new Error("The composer has no chip or no text after it.");
      }
      const range = document.createRange();
      range.setStart(last, last.length - 1);
      range.setEnd(last, last.length);
      const space = range.getBoundingClientRect();
      const chipBox = pill.getBoundingClientRect();
      return {
        spaceMiddle: space.top + space.height / 2,
        chipTop: chipBox.top,
        chipBottom: chipBox.bottom,
      };
    }, CHIP);
    expect(lines.spaceMiddle).toBeGreaterThan(lines.chipTop);
    expect(lines.spaceMiddle).toBeLessThan(lines.chipBottom);
  });
}
