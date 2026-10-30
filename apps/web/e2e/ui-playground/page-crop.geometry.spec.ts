import type { Page } from "@playwright/test";

import {
  expect,
  stableBoundingBox,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

const field = (page: Page, side: string) =>
  page.locator(`input[type="number"][id$="-${side}"]`);
const box = (page: Page) => page.locator("[data-crop-box]");

const openFixture = async (page: Page) => {
  await page.goto("/dev?visual=page-crop", { waitUntil: "domcontentloaded" });
  await expect(box(page)).toBeVisible();
  await page.locator('[role="dialog"] summary').click();
};

const readBox = async (page: Page) => {
  await waitForStableGeometry(page, box(page).locator(".."));
  return await box(page).evaluate((element) => {
    const preview = element.parentElement?.querySelector("canvas");
    if (!(preview instanceof HTMLCanvasElement)) {
      throw new Error("PDF preview is missing");
    }
    const surface = preview.getBoundingClientRect();
    const crop = element.getBoundingClientRect();
    return {
      x: (crop.x - surface.x) / surface.width,
      y: (crop.y - surface.y) / surface.height,
      width: crop.width / surface.width,
      height: crop.height / surface.height,
      surfaceWidth: surface.width,
      surfaceHeight: surface.height,
    };
  });
};

const readAppliedMargins = async (page: Page) =>
  page.locator("[data-crop-output]").evaluate((element) => {
    const parsed: unknown = JSON.parse(element.textContent);
    if (!Array.isArray(parsed)) {
      throw new TypeError("Expected applied page crops");
    }
    return parsed.map((value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("widthMm" in value) ||
        !("heightMm" in value) ||
        !("crop" in value) ||
        typeof value.widthMm !== "number" ||
        typeof value.heightMm !== "number"
      ) {
        throw new Error("Invalid applied page dimensions");
      }
      const crop = value.crop;
      if (
        typeof crop !== "object" ||
        crop === null ||
        !("x" in crop) ||
        !("y" in crop) ||
        !("width" in crop) ||
        !("height" in crop) ||
        typeof crop.x !== "number" ||
        typeof crop.y !== "number" ||
        typeof crop.width !== "number" ||
        typeof crop.height !== "number"
      ) {
        throw new Error("Invalid applied crop");
      }
      return {
        widthMm: value.widthMm,
        heightMm: value.heightMm,
        left: crop.x * value.widthMm,
        right: (1 - crop.x - crop.width) * value.widthMm,
        bottom: crop.y * value.heightMm,
        top: (1 - crop.y - crop.height) * value.heightMm,
      };
    });
  });

test("renders PDF content and restores existing physical crop margins", async ({
  page,
}) => {
  await openFixture(page);
  for (const [side, expected] of Object.entries({
    top: 10,
    right: 15,
    bottom: 20,
    left: 25,
  })) {
    await expect(field(page, side)).toHaveValue(String(expected));
  }
  const geometry = await readBox(page);
  expect(geometry.x).toBeCloseTo(25 / 210, 2);
  expect(geometry.y).toBeCloseTo(10 / 297, 2);
  const contentRendered = await page
    .locator('[role="dialog"] canvas')
    .evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) {
        return false;
      }
      const pixels = canvas
        .getContext("2d")
        ?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels) {
        return false;
      }
      for (let i = 0; i < pixels.length; i += 4) {
        if ((pixels[i] ?? 255) < 200 && (pixels[i + 3] ?? 0) > 0) {
          return true;
        }
      }
      return false;
    });
  expect(contentRendered).toBe(true);
  await page.locator('[data-crop-action="apply"]').click();
  await page.locator("[data-crop-reopen]").click();
  await expect(box(page)).toBeVisible();
  await page.locator('[role="dialog"] summary').click();
  await expect(field(page, "left")).toHaveValue("25");
  expect((await readBox(page)).x).toBeCloseTo(geometry.x, 3);
});

test("numeric edits and pointer resizing update the same crop rectangle", async ({
  page,
}) => {
  await openFixture(page);
  await field(page, "top").fill("30");
  expect((await readBox(page)).y).toBeCloseTo(30 / 297, 2);
  const handle = page.locator('[data-crop-handle="e"]');
  const start = await stableBoundingBox(page, handle);
  const before = await readBox(page);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2 + (before.surfaceWidth * 5) / 210,
    start.y + start.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await field(page, "right").inputValue()))
    .toBeCloseTo(10, 1);
  expect((await readBox(page)).width).toBeGreaterThan(before.width);
});

test("keyboard adjustments use 1 mm and Shift uses 10 mm", async ({ page }) => {
  await openFixture(page);
  const handle = page.locator('[data-crop-handle="n"]');
  await handle.focus();
  await handle.press("ArrowDown");
  await expect(field(page, "top")).toHaveValue("11");
  await handle.press("Shift+ArrowDown");
  await expect(field(page, "top")).toHaveValue("21");
  const move = box(page).locator(":scope > button").first();
  await move.focus();
  await move.press("ArrowRight");
  await expect(field(page, "left")).toHaveValue("26");
  await expect(field(page, "right")).toHaveValue("14");
});

test("mixed page sizes and rotation preserve one physical margin draft", async ({
  page,
}) => {
  await openFixture(page);
  await field(page, "left").fill("30");
  await page.locator('[data-crop-action="next"]').click();
  await expect(box(page)).toBeVisible();
  await expect(field(page, "left")).toHaveValue("30");
  const second = await readBox(page);
  expect(second.x).toBeCloseTo(30 / 148.5, 2);
  expect(second.y).toBeCloseTo(10 / 105, 2);
  await page.locator('[data-crop-action="apply"]').click();
  const applied = await readAppliedMargins(page);
  expect(applied).toHaveLength(2);
  expect(applied.at(0)?.widthMm).toBeCloseTo(210, 2);
  expect(applied.at(1)?.widthMm).toBeCloseTo(148.5, 2);
  for (const margins of applied) {
    expect(margins.left).toBeCloseTo(30, 2);
    expect(margins.right).toBeCloseTo(15, 2);
    expect(margins.top).toBeCloseTo(10, 2);
    expect(margins.bottom).toBeCloseTo(20, 2);
  }
});

test("reset clears stored crops and reopening shows the full source page", async ({
  page,
}) => {
  await openFixture(page);
  await page.locator('[data-crop-action="reset"]').click();
  await expect(page.locator("[data-crop-output]")).toContainText('"crop":null');
  await page.locator("[data-crop-reopen]").click();
  await expect(box(page)).toBeVisible();
  await page.locator('[role="dialog"] summary').click();
  for (const side of ["top", "right", "bottom", "left"]) {
    await expect(field(page, side)).toHaveValue("0");
  }
});
