import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type FrameSample = {
  anchorInsideReader: boolean;
  focusInsideReader: boolean;
  length: number;
};

const openReader = async (page: Page) => {
  await page.goto("/dev?visual=reader-selection", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("reader")).toBeVisible();
};

/** Records the selection on every animation frame until stopped. */
const recordSelectionFrames = async (page: Page) => {
  await page.evaluate(() => {
    const reader = window.document.querySelector('[data-testid="reader"]');
    const samples: FrameSample[] = [];
    let running = true;
    const tick = () => {
      const selection = window.document.getSelection();
      if (selection !== null && selection.rangeCount > 0) {
        samples.push({
          anchorInsideReader: reader?.contains(selection.anchorNode) ?? false,
          focusInsideReader: reader?.contains(selection.focusNode) ?? false,
          length: selection.toString().length,
        });
      }
      if (running) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    Reflect.set(window, "stopSelectionFrames", () => {
      running = false;
      return samples;
    });
  });
};

const stopSelectionFrames = async (page: Page): Promise<FrameSample[]> =>
  await page.evaluate(() => {
    const stop: unknown = Reflect.get(window, "stopSelectionFrames");
    if (typeof stop !== "function") {
      throw new TypeError("Selection recorder was not installed");
    }
    const samples: unknown = stop();
    if (!Array.isArray(samples)) {
      throw new TypeError("Selection recorder returned no samples");
    }
    return samples.flatMap((sample: unknown): FrameSample[] =>
      typeof sample === "object" &&
      sample !== null &&
      "anchorInsideReader" in sample &&
      "focusInsideReader" in sample &&
      "length" in sample &&
      typeof sample.anchorInsideReader === "boolean" &&
      typeof sample.focusInsideReader === "boolean" &&
      typeof sample.length === "number"
        ? [
            {
              anchorInsideReader: sample.anchorInsideReader,
              focusInsideReader: sample.focusInsideReader,
              length: sample.length,
            },
          ]
        : [],
    );
  });

const paragraphBox = async (page: Page, index: number) => {
  const box = await page
    .locator(`[data-testid="reader"] p[data-anchor="p-${index}"]`)
    .boundingBox();
  if (box === null) {
    throw new Error(`Paragraph ${index} has no box`);
  }
  return box;
};

// Paragraph boxes include the part the reader's scroll area clips, so a
// later paragraph can sit far below the visible reader. A drag point aimed
// at such a box lands outside the reader, and a pointer held there is a
// different gesture from a drag across the paragraphs. Every drag point
// stays this far inside the visible reader, clear of the edge band where
// the browser starts to scroll the reader under the pointer.
const READER_EDGE_INSET = 48;

/** The lowest drag point that is still inside the visible reader. */
const readerDragFloor = async (page: Page): Promise<number> => {
  const viewport = await page
    .locator('[data-slot="scroll-area-viewport"]', {
      has: page.getByTestId("reader"),
    })
    .boundingBox();
  if (viewport === null) {
    throw new Error("The reader viewport has no box");
  }
  return viewport.y + viewport.height - READER_EDGE_INSET;
};

// The reader's bar is the one fixed reader-chrome element on the page.
const selectionBar = (page: Page) => page.locator("div.fixed.reader-chrome");

test("a fast drag across paragraphs never selects past the reader", async ({
  page,
}) => {
  await openReader(page);
  const first = await paragraphBox(page, 1);
  const floor = await readerDragFloor(page);
  // The sweep crosses at least one gap between paragraphs.
  expect((await paragraphBox(page, 2)).y).toBeLessThan(floor);
  const readerText =
    (await page.getByTestId("reader").textContent())?.length ?? 0;
  await recordSelectionFrames(page);
  await page.mouse.move(first.x + 4, first.y + 6);
  await page.mouse.down();
  // Sweep down and up over the paragraphs and the gaps between them, the
  // way a reader overshoots and corrects, a few frames per sweep.
  for (let sweep = 0; sweep < 6; sweep += 1) {
    const down = sweep % 2 === 0;
    for (let step = 1; step <= 12; step += 1) {
      const fraction = down ? step / 12 : 1 - step / 12;
      await page.mouse.move(
        first.x + 40 + fraction * 300,
        first.y + 30 + fraction * (floor - first.y - 30),
      );
    }
  }
  await page.mouse.up();
  const samples = await stopSelectionFrames(page);
  expect(samples.length).toBeGreaterThan(10);
  // The drag must have selected text, or containment proves nothing.
  expect(samples.some((sample) => sample.length > 0)).toBe(true);
  const escaped = samples.filter(
    (sample) =>
      !sample.anchorInsideReader ||
      !sample.focusInsideReader ||
      sample.length > readerText,
  );
  expect(escaped).toEqual([]);
});

// Quarantined: the right-to-left run reads the bar's position before layout
// settles after the drag and fails intermittently in merge groups. The fix
// measures through the shared stable-geometry helper and removes this skip.
// test-quarantine-expires: 2026-10-30T00:00:00.000Z
test.skip("the selection bar keeps its place once the drag ends", async ({
  page,
}) => {
  await openReader(page);
  const first = await paragraphBox(page, 2);
  const last = await paragraphBox(page, 4);
  const end = Math.min(last.y + 10, await readerDragFloor(page));
  await page.mouse.move(first.x + 4, first.y + 6);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(
      first.x + 4 + (step / 10) * 260,
      first.y + 6 + (step / 10) * (end - first.y - 6),
    );
  }
  const duringDrag = await selectionBar(page).count();
  await page.mouse.up();
  await expect(selectionBar(page)).toBeVisible();
  const shown = await selectionBar(page).boundingBox();
  // About 300 ms at 60 Hz: long enough for any settle or enter animation.
  await page.evaluate(
    async () =>
      await new Promise<void>((resolve) => {
        let frames = 0;
        const next = () => {
          frames += 1;
          if (frames >= 18) {
            resolve();
            return;
          }
          requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
  );
  const settled = await selectionBar(page).boundingBox();
  expect(duringDrag).toBe(0);
  expect(shown).not.toBeNull();
  expect(settled).toEqual(shown);
});

test("the copy menu's preview stays inside the menu", async ({ page }) => {
  await openReader(page);
  const first = await paragraphBox(page, 2);
  await page.mouse.move(first.x + 4, first.y + 6);
  await page.mouse.down();
  await page.mouse.move(first.x + 260, first.y + 40, { steps: 10 });
  await page.mouse.up();
  await selectionBar(page).getByRole("button", { name: "Copy" }).click();
  const layout = page.locator('[data-slot="menu-preview-layout"]');
  const options = layout.getByRole("button");
  await expect(options.first()).toBeVisible();
  const menu = await layout.locator("xpath=..").boundingBox();
  if (menu === null) {
    throw new Error("The copy menu has no box");
  }
  for (const option of await options.all()) {
    await option.hover();
    // The toolbar is narrower than options plus pane, so a box here also
    // proves the menu widened instead of dropping the pane.
    const pane = await layout
      .locator('[data-slot="preview-pane"]')
      .boundingBox();
    if (pane === null) {
      throw new Error("The copy preview has no box");
    }
    expect(pane.x).toBeGreaterThanOrEqual(menu.x);
    expect(pane.x + pane.width).toBeLessThanOrEqual(menu.x + menu.width);
  }
});
