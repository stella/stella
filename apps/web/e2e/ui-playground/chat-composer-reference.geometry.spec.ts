/**
 * A reference chip never makes the chat composer scroll sideways.
 *
 * The bench at `/dev?visual=chat-composer-reference` mounts the product's
 * composer at 300px, the width of a docked chat panel, with a document
 * mention whose name is wider than the editor. Every project runs this, so
 * it is measured under `ar` (RTL) as well.
 */

import { composerReferenceStates } from "../../src/routes/dev/-visual-metadata";
import { findControlsOverText } from "../helpers/control-over-text";
import {
  expect,
  stableBoundingBox,
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
        throw new TypeError("The composer rendered no reference chip.");
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

    // Static editor chips retain the full name without adding a control.
    const label = await chip.locator("bdi").textContent();
    await expect(chip).not.toHaveAttribute("title");
    await expect(chip).toHaveAccessibleName(label ?? "");
    await expect(chip).not.toHaveRole("button");
    // However the draft lays the composer out, no control covers its text.
    expect(await findControlsOverText(section)).toEqual([]);
  });
}

// A draft taller than the text region scrolls inside it, the text across the
// box over the control row: the controls never sit beside or over a line.
test("the long draft scrolls above the composer's control row", async ({
  page,
}) => {
  await page.goto("/dev?visual=chat-composer-reference", {
    waitUntil: "domcontentloaded",
  });
  const section = page.locator(
    '[data-playground-section="chat-composer-reference:compact-draft"]',
  );
  const frame = section.locator('[data-slot="composer-frame"]');
  await expect(frame).toHaveAttribute("data-composer-layout", "stacked");
  await waitForStableGeometry(page, section);

  const geometry = await frame.evaluate((box) => {
    const rect = (selector: string) => {
      const element = box.querySelector(selector);
      if (element === null) {
        throw new Error(`The composer has no ${selector}.`);
      }
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const viewport = box.querySelector('[data-slot="scroll-area-viewport"]');
    const { left, right } = box.getBoundingClientRect();
    return {
      box: { left, right },
      region: rect('[data-slot="composer-text-region"]'),
      trailing: rect('[data-slot="composer-trailing"]'),
      leading: rect('[data-slot="composer-leading"]'),
      overflows:
        viewport !== null && viewport.scrollHeight > viewport.clientHeight,
    };
  });
  expect(Math.round(geometry.region.bottom - geometry.region.top)).toBe(320);
  expect(geometry.overflows).toBe(true);
  expect(geometry.trailing.top).toBeGreaterThanOrEqual(
    geometry.region.bottom - EPSILON_PX,
  );
  expect(geometry.leading.top).toBeGreaterThanOrEqual(
    geometry.region.bottom - EPSILON_PX,
  );
  // The region spans the box, so its scrollbar sits at the box's edge.
  expect(geometry.region.right - geometry.region.left).toBeGreaterThan(
    geometry.box.right - geometry.box.left - 20,
  );
  expect(await findControlsOverText(section)).toEqual([]);
});

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

test("inline pill hints follow keyboard focus without changing activation", async ({
  page,
}) => {
  await page.goto("/dev?visual=chat-composer-reference", {
    waitUntil: "domcontentloaded",
  });
  const section = page.locator('[data-playground-section="inline-pill-hints"]');
  await expect(section).toBeVisible();
  await section.getByTestId("hint-start").focus();
  await page.keyboard.press("Tab");
  const title = section.getByRole("button", {
    name: "Title fallback",
    exact: true,
  });
  await expect(title).toBeFocused();
  const popup = page.locator('[data-slot="tooltip-popup"][data-open]');
  await expect(popup).toHaveCount(1);
  await expect(popup).toBeVisible();
  await expect(popup).toHaveText("Full matter name from title");
  await page.keyboard.press("Tab");
  const rich = section.getByRole("button", { name: "Rich hint", exact: true });
  await expect(rich).toBeFocused();
  await expect(popup).toHaveCount(1);
  await expect(popup).toBeVisible();
  await expect(popup.locator("strong")).toHaveText("Rich matter context");
  await expect(section.locator("[title]")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(section.getByTestId("hint-activations")).toHaveText("1");
  await page.keyboard.press("Tab");
  await expect(section.getByTestId("hint-end")).toBeFocused();
});

for (const source of ["skill", "prompt"] as const) {
  test(`the ${source} editor chip owns one focusable hint and opens its editor`, async ({
    page,
  }) => {
    await page.goto("/dev?visual=chat-composer-reference", {
      waitUntil: "domcontentloaded",
    });
    const section = page.locator(
      '[data-playground-section="pasted-reference-hints"]',
    );
    const node = section.locator(`[data-source="${source}"]`);
    const trigger = node.getByRole("button");
    await expect(trigger).toHaveCount(1);
    await expect(trigger).toBeVisible();
    await expect(trigger.locator("button, [tabindex='0']")).toHaveCount(0);
    const label = await node.locator("bdi").textContent();
    await trigger.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    await expect(
      page.locator('[data-slot="tooltip-popup"][data-open]'),
    ).toHaveText(label ?? "");
    await page.keyboard.press("Enter");
    const popup = page.locator('[data-slot="popover-popup"]');
    await expect(popup.locator("textarea")).toBeVisible();
    await expect(popup.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(popup.locator("textarea")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}

test("hint-bearing chips keep a full coarse-pointer target", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto("/dev?visual=chat-composer-reference", {
      waitUntil: "domcontentloaded",
    });
    const section = page.locator(
      '[data-playground-section="inline-pill-hints"]',
    );
    const trigger = section.getByRole("button", {
      name: "Title fallback",
      exact: true,
    });
    await expect(trigger).toBeVisible();
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const box = await stableBoundingBox(page, trigger);
    const paintedReference = await stableBoundingBox(
      page,
      section.getByRole("group"),
    );
    expect(box.height).toBe(paintedReference.height);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  } finally {
    await context.close();
  }
});
