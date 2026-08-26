import { expect, test } from "@playwright/test";
import type { CDPSession, Locator, Page } from "@playwright/test";

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

const enableNativeTouch = async (page: Page) => {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  return session;
};

const dispatchNativeTouch = async (
  session: CDPSession,
  type: "touchCancel" | "touchEnd" | "touchMove" | "touchStart",
  touches: readonly { clientX: number; clientY: number }[],
) => {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: touches.map(({ clientX, clientY }, index) => ({
      id: index + 1,
      x: clientX,
      y: clientY,
    })),
  });
};

const dispatchSecondaryTouch = async (
  handle: Locator,
  type: "touchcancel" | "touchend" | "touchmove",
  primary: { clientX: number; clientY: number },
  secondary: { clientX: number; clientY: number },
) => {
  await handle.evaluate(
    (element, event) => {
      const primaryTouch = new Touch({
        identifier: 1,
        target: element,
        clientX: event.primary.clientX,
        clientY: event.primary.clientY,
      });
      const secondaryTouch = new Touch({
        identifier: 2,
        target: element,
        clientX: event.secondary.clientX,
        clientY: event.secondary.clientY,
      });
      element.dispatchEvent(
        new TouchEvent(event.type, {
          bubbles: true,
          changedTouches: [secondaryTouch],
          touches:
            event.type === "touchend"
              ? [primaryTouch]
              : [primaryTouch, secondaryTouch],
        }),
      );
    },
    { primary, secondary, type },
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

  await list.hover();
  await page.mouse.wheel(0, 72);
  await board.hover({ position: { x: 300, y: 160 } });
  await page.mouse.wheel(180, 0);

  await expect
    .poll(async () => await board.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => await list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await board.hover({ position: { x: 300, y: 160 } });
  await page.mouse.wheel(-180, 0);
  await list.hover();
  await page.mouse.wheel(0, -72);

  await expect
    .poll(async () => await board.evaluate((element) => element.scrollLeft))
    .toBe(0);
  await expect
    .poll(async () => await list.evaluate((element) => element.scrollTop))
    .toBe(0);

  const coordinates = await getTouchCoordinates(handle);
  const nativeTouch = await enableNativeTouch(page);
  await dispatchNativeTouch(nativeTouch, "touchStart", [coordinates]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await dispatchNativeTouch(nativeTouch, "touchEnd", []);
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
  const nativeTouch = await enableNativeTouch(page);

  await page.evaluate(() => {
    document.addEventListener(
      "touchstart",
      () => {
        document.documentElement.dataset["touchStartedAt"] = String(
          performance.now(),
        );
      },
      { capture: true, once: true },
    );
  });
  await dispatchNativeTouch(nativeTouch, "touchStart", [coordinates]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  const touchDelay = await page.evaluate(() => {
    const dragStartedAt = document.documentElement.dataset["dragStartedAt"];
    const touchStartedAt = document.documentElement.dataset["touchStartedAt"];
    if (!dragStartedAt || !touchStartedAt) {
      throw new Error("Missing touch delay timestamps");
    }
    return Number(dragStartedAt) - Number(touchStartedAt);
  });
  expect(touchDelay).toBeGreaterThanOrEqual(150);
  await dispatchNativeTouch(nativeTouch, "touchEnd", []);

  const toleranceHandle = await openFixture(page);
  const toleranceCoordinates = await getTouchCoordinates(toleranceHandle);
  const toleranceNativeTouch = await enableNativeTouch(page);
  await dispatchNativeTouch(toleranceNativeTouch, "touchStart", [
    toleranceCoordinates,
  ]);
  await dispatchNativeTouch(toleranceNativeTouch, "touchMove", [
    {
      clientX: toleranceCoordinates.clientX + 24,
      clientY: toleranceCoordinates.clientY,
    },
  ]);
  await page.waitForTimeout(170);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
});

test("ignores a secondary finger's move, end, and cancel events", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const primary = await getTouchCoordinates(handle);
  const secondary = {
    clientX: primary.clientX + 24,
    clientY: primary.clientY,
  };
  const nativeTouch = await enableNativeTouch(page);

  await dispatchNativeTouch(nativeTouch, "touchStart", [primary]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");

  await dispatchSecondaryTouch(handle, "touchmove", primary, {
    clientX: secondary.clientX + 48,
    clientY: secondary.clientY,
  });
  await expect(page.locator("[data-overlay]")).toHaveText("first");

  await dispatchSecondaryTouch(handle, "touchend", primary, secondary);
  await expect(page.locator("[data-overlay]")).toHaveText("first");

  await dispatchSecondaryTouch(handle, "touchcancel", primary, secondary);
  await expect(page.locator("[data-overlay]")).toHaveText("first");

  await dispatchNativeTouch(nativeTouch, "touchEnd", []);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
});

test("starts keyboard dragging from the handle", async ({ page }) => {
  const handle = await openFixture(page);

  await handle.focus();
  await page.keyboard.press("Space");

  await expect(page.locator("[data-overlay]")).toHaveText("first");
});
