import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const fixturePath = "/src/kanban/fixtures/sortable-interactions.fixture.html";

const openFixture = async (page: Page) => {
  await page.goto(fixturePath);
  return page.getByRole("button", { name: "Move first" });
};

const getTouchCoordinates = async (handle: Locator) => {
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error("Missing drag handle bounds");
  }
  return { clientX: box.x + 12, clientY: box.y + 12 };
};

const dispatchTouch = async (
  handle: Locator,
  type: "touchend" | "touchmove" | "touchstart",
  coordinates: { clientX: number; clientY: number },
) => {
  await handle.evaluate(
    (element, event) => {
      const touch = new Touch({
        identifier: 1,
        target: element,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      const touches = event.type === "touchend" ? [] : [touch];
      element.dispatchEvent(
        new TouchEvent(event.type, {
          bubbles: true,
          changedTouches: [touch],
          touches,
        }),
      );
    },
    { ...coordinates, type },
  );
};

test("preserves native board and list scrolling while a handle activates touch dragging", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const board = page.locator("[data-board]");
  const list = page.locator("[data-list]");

  await expect(board).toHaveCSS("touch-action", "auto");
  await expect(list).toHaveCSS("touch-action", "auto");
  await expect(handle).toHaveCSS("touch-action", "none");

  await board.evaluate((element) => {
    element.scrollLeft = 180;
  });
  await list.evaluate((element) => {
    element.scrollTop = 72;
  });

  await expect
    .poll(async () => await board.evaluate((element) => element.scrollLeft))
    .toBe(180);
  await expect
    .poll(async () => await list.evaluate((element) => element.scrollTop))
    .toBe(72);

  const coordinates = await getTouchCoordinates(handle);
  await dispatchTouch(handle, "touchstart", coordinates);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await dispatchTouch(handle, "touchend", coordinates);
});

test("activates a mouse drag only after its distance threshold", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error("Missing drag handle bounds");
  }

  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 19, box.y + 12);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
  await page.mouse.move(box.x + 21, box.y + 12);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await page.mouse.up();
});

test("waits for the touch delay and cancels when movement exceeds its tolerance", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const coordinates = await getTouchCoordinates(handle);

  await dispatchTouch(handle, "touchstart", coordinates);
  await page.waitForTimeout(80);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
  await page.waitForTimeout(90);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await dispatchTouch(handle, "touchend", coordinates);

  const toleranceHandle = await openFixture(page);
  const toleranceCoordinates = await getTouchCoordinates(toleranceHandle);
  await dispatchTouch(toleranceHandle, "touchstart", toleranceCoordinates);
  await dispatchTouch(toleranceHandle, "touchmove", {
    clientX: toleranceCoordinates.clientX + 9,
    clientY: toleranceCoordinates.clientY,
  });
  await page.waitForTimeout(170);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
});

test("starts keyboard dragging from the handle", async ({ page }) => {
  const handle = await openFixture(page);

  await handle.focus();
  await page.keyboard.press("Space");

  await expect(page.locator("[data-overlay]")).toHaveText("first");
});
