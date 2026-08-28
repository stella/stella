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
  return { clientX: box.x + 12, clientY: box.y + 12, id: 1 };
};

const enableNativeTouch = async (page: Page) => {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 2,
  });
  return session;
};

type NativeTouchPoint = {
  clientX: number;
  clientY: number;
  id: number;
};

const dispatchNativeTouch = async (
  session: CDPSession,
  type: "touchMove" | "touchStart",
  touches: readonly NativeTouchPoint[],
) => {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: touches.map(({ clientX, clientY, id }) => ({
      id,
      x: clientX,
      y: clientY,
    })),
  });
};

const endNativeTouch = async (session: CDPSession) => {
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
};

const cancelNativeTouch = async (session: CDPSession) => {
  await session.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
};

const scrollWithTouch = async (
  page: Page,
  session: CDPSession,
  {
    x,
    xDistance = 0,
    y,
    yDistance = 0,
  }: {
    x: number;
    xDistance?: number;
    y: number;
    yDistance?: number;
  },
) => {
  const start = { clientX: x, clientY: y, id: 1 };
  await dispatchNativeTouch(session, "touchStart", [start]);

  const scrollSteps = 4;
  const moveToNextScrollPosition = async (step: number): Promise<void> => {
    if (step > scrollSteps) {
      return;
    }
    const progress = step / scrollSteps;
    await dispatchNativeTouch(session, "touchMove", [
      {
        clientX: x + xDistance * progress,
        clientY: y + yDistance * progress,
        id: start.id,
      },
    ]);
    await page.waitForTimeout(16);
    await moveToNextScrollPosition(step + 1);
  };
  await moveToNextScrollPosition(1);
  await endNativeTouch(session);
};

test("preserves native board and list scrolling", async ({ page }) => {
  const handle = await openFixture(page);
  const board = page.locator("[data-board]");
  const list = page.locator(".kanban-test-list").first();

  await expect(board).toHaveCSS("touch-action", "auto");
  await expect(list).toHaveCSS("touch-action", "auto");
  await expect(handle).toHaveCSS("touch-action", "none");

  const boardBox = await board.boundingBox();
  const listBox = await list.boundingBox();
  if (!boardBox || !listBox) {
    throw new Error("Missing scroll container bounds");
  }
  const nativeTouch = await enableNativeTouch(page);

  await scrollWithTouch(page, nativeTouch, {
    x: boardBox.x + 100,
    y: listBox.y + listBox.height - 12,
    yDistance: -80,
  });
  await scrollWithTouch(page, nativeTouch, {
    x: boardBox.x + boardBox.width - 12,
    y: boardBox.y + boardBox.height - 12,
    xDistance: -180,
  });

  await expect
    .poll(async () => await board.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => await list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
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
  await endNativeTouch(nativeTouch);

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
      id: toleranceCoordinates.id,
    },
  ]);
  await page.waitForTimeout(170);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
});

test("ignores a secondary finger's native move", async ({ page }) => {
  const handle = await openFixture(page);
  const primary = await getTouchCoordinates(handle);
  const secondary: NativeTouchPoint = {
    clientX: primary.clientX + 24,
    clientY: primary.clientY,
    id: 2,
  };
  const nativeTouch = await enableNativeTouch(page);

  await dispatchNativeTouch(nativeTouch, "touchStart", [primary]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");

  await dispatchNativeTouch(nativeTouch, "touchStart", [primary, secondary]);
  await dispatchNativeTouch(nativeTouch, "touchMove", [
    primary,
    {
      clientX: secondary.clientX + 48,
      clientY: secondary.clientY,
      id: secondary.id,
    },
  ]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");

  await expect(page.locator("[data-overlay]")).toHaveText("first");

  await endNativeTouch(nativeTouch);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
});

test("handles native multi-touch cancellation", async ({ page }) => {
  const handle = await openFixture(page);
  const primary = await getTouchCoordinates(handle);
  const secondary: NativeTouchPoint = {
    clientX: primary.clientX + 24,
    clientY: primary.clientY,
    id: 2,
  };
  const nativeTouch = await enableNativeTouch(page);

  await dispatchNativeTouch(nativeTouch, "touchStart", [primary]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await dispatchNativeTouch(nativeTouch, "touchStart", [primary, secondary]);
  await cancelNativeTouch(nativeTouch);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
});

test("cleans up a cancelled touch sensor before the next drag", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const first = await getTouchCoordinates(handle);
  const nativeTouch = await enableNativeTouch(page);

  await dispatchNativeTouch(nativeTouch, "touchStart", [first]);
  await dispatchNativeTouch(nativeTouch, "touchMove", [
    { clientX: first.clientX + 24, clientY: first.clientY, id: first.id },
  ]);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);

  await page.evaluate(() => {
    document.addEventListener(
      "touchmove",
      () => {
        document.documentElement.dataset["subsequentTouchMove"] = "seen";
      },
      { capture: true, once: true },
    );
  });
  const secondary = { ...first, clientX: first.clientX + 24, id: 2 };
  await dispatchNativeTouch(nativeTouch, "touchStart", [first, secondary]);
  await dispatchNativeTouch(nativeTouch, "touchMove", [
    first,
    { ...secondary, clientX: secondary.clientX + 24 },
  ]);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["subsequentTouchMove"],
        ),
    )
    .toBe("seen");
  await endNativeTouch(nativeTouch);

  const next = { ...first, id: 3 };
  await dispatchNativeTouch(nativeTouch, "touchStart", [next]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await endNativeTouch(nativeTouch);
  await expect(page.locator("[data-overlay]")).toHaveCount(0);
});

test("starts keyboard dragging from the handle", async ({ page }) => {
  const handle = await openFixture(page);

  await handle.focus();
  await page.keyboard.press("Space");

  await expect(page.locator("[data-overlay]")).toHaveText("first");
});

test("drops a touch drag into an adjacent virtual cell", async ({ page }) => {
  const handle = await openFixture(page);
  const target = page.getByRole("button", { name: "Move second" });
  const sourceCoordinates = await getTouchCoordinates(handle);
  const targetCoordinates = await getTouchCoordinates(target);
  const nativeTouch = await enableNativeTouch(page);

  await dispatchNativeTouch(nativeTouch, "touchStart", [sourceCoordinates]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await dispatchNativeTouch(nativeTouch, "touchMove", [targetCoordinates]);
  await endNativeTouch(nativeTouch);

  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "",
        ),
    )
    .toBe("second");
});

test("drops a keyboard drag into an adjacent virtual cell", async ({
  page,
}) => {
  const handle = await openFixture(page);

  await handle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");

  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "",
        ),
    )
    .toBe("second");
});
