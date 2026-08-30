import { expect, test } from "@playwright/test";
import type { CDPSession, Locator, Page } from "@playwright/test";

const fixturePath = "/src/kanban/fixtures/sortable-interactions.fixture.html";

const openFixture = async (page: Page) => {
  await page.goto(fixturePath);
  return page.getByRole("button", { name: "Move first" });
};

/** Keyboard navigation must work once the drag is live, not only in the same tick. */
const expectDragActivated = async (page: Page) => {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["dragStartedAt"] ?? "",
        ),
    )
    .not.toBe("");
};

const getTouchCoordinates = async (handle: Locator) => {
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error("Missing drag handle bounds");
  }
  return { clientX: box.x + 12, clientY: box.y + 12, id: 1 };
};

const getCenterCoordinates = async (target: Locator, id = 1) => {
  const box = await target.boundingBox();
  if (!box) {
    throw new Error("Missing target bounds");
  }
  return {
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    id,
  };
};

const startMouseDrag = async (page: Page, handle: Locator) => {
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error("Missing drag handle bounds");
  }
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 21, box.y + 12);
  await expect(page.locator("[data-overlay]")).toBeVisible();
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

test("exposes explicit whole-item and 44px handle activation surfaces", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const wholeItem = page.getByRole("button", { name: "Move whole-item" });

  await expect(handle).toHaveCSS("width", "44px");
  await expect(handle).toHaveCSS("height", "44px");
  await expect(handle).toHaveCSS("touch-action", "none");
  await expect(
    handle.locator("xpath=ancestor::*[@data-sortable-item]"),
  ).toHaveCSS("touch-action", "auto");
  await expect(wholeItem).toHaveCSS("touch-action", "none");

  await wholeItem.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("[data-overlay]")).toHaveText("whole-item");
  await page.keyboard.press("Escape");
});

test("keeps the drag overlay above sticky board chrome", async ({ page }) => {
  const handle = await openFixture(page);
  await handle.focus();
  await page.keyboard.press("Space");

  const overlayZIndex = await page
    .locator("[data-overlay]")
    .evaluate((node) =>
      Number(getComputedStyle(node.parentElement ?? node).zIndex),
    );
  const chromeZIndex = await page
    .locator("[data-board-chrome]")
    .evaluate((node) => Number(getComputedStyle(node).zIndex));
  expect(overlayZIndex).toBeGreaterThan(chromeZIndex);
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

test("drops a whole-item touch drag across a virtual column", async ({
  page,
}) => {
  await openFixture(page);
  const wholeItem = page.getByRole("button", { name: "Move whole-item" });
  const sourceCell = page.locator('[data-kanban-cell="cell-d"]');
  await sourceCell.evaluate((element) => {
    element.scrollTop = 96;
  });
  await expect
    .poll(async () => await sourceCell.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const sourceCoordinates = await getTouchCoordinates(wholeItem);
  const targetCoordinates = await getTouchCoordinates(
    page.getByRole("button", { name: "Move lane-second" }),
  );
  const nativeTouch = await enableNativeTouch(page);

  await dispatchNativeTouch(nativeTouch, "touchStart", [sourceCoordinates]);
  await expect(page.locator("[data-overlay]")).toHaveText("whole-item");
  await dispatchNativeTouch(nativeTouch, "touchMove", [targetCoordinates]);
  await endNativeTouch(nativeTouch);

  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "",
        ),
    )
    .toBe("lane-second");
});

test("drops pointer and touch input into an empty virtual cell", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const emptyCell = page.locator('[data-kanban-cell="cell-b"]');
  const emptyCoordinates = await getCenterCoordinates(emptyCell);

  await startMouseDrag(page, handle);
  await page.mouse.move(emptyCoordinates.clientX, emptyCoordinates.clientY);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["draggedOver"] ?? "",
        ),
    )
    .toBe("cell-b");
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "",
        ),
    )
    .toBe("cell-b");

  await page.reload();
  const touchHandle = page.getByRole("button", { name: "Move first" });
  const touchSource = await getTouchCoordinates(touchHandle);
  const touchTarget = await getCenterCoordinates(
    page.locator('[data-kanban-cell="cell-b"]'),
  );
  const nativeTouch = await enableNativeTouch(page);
  await dispatchNativeTouch(nativeTouch, "touchStart", [touchSource]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await dispatchNativeTouch(nativeTouch, "touchMove", [touchTarget]);
  await endNativeTouch(nativeTouch);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "",
        ),
    )
    .toBe("cell-b");
});

test("cancels a pointer drop outside the registered board", async ({
  page,
}) => {
  const handle = await openFixture(page);
  await startMouseDrag(page, handle);
  await page.mouse.move(1, 1);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["draggedOver"] ?? "missing",
        ),
    )
    .toBe("");
  await page.mouse.up();

  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "missing",
        ),
    )
    .toBe("");
});

test("auto-scrolls vertical cells and the horizontal board during a pointer drag", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const sourceCell = page.locator('[data-kanban-cell="cell-a"]');
  const board = page.locator("[data-board]");
  const sourceBox = await sourceCell.boundingBox();
  const boardBox = await board.boundingBox();
  if (!sourceBox || !boardBox) {
    throw new Error("Missing auto-scroll bounds");
  }

  await startMouseDrag(page, handle);
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height - 2,
  );
  await expect
    .poll(async () => await sourceCell.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await page.mouse.move(boardBox.x + boardBox.width - 2, boardBox.y + 40);
  await expect
    .poll(async () => await board.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  await page.mouse.up();
});

test("auto-scrolls during an active touch drag", async ({ page }) => {
  const handle = await openFixture(page);
  const sourceCell = page.locator('[data-kanban-cell="cell-a"]');
  const board = page.locator("[data-board]");
  const source = await getTouchCoordinates(handle);
  const sourceBox = await sourceCell.boundingBox();
  const boardBox = await board.boundingBox();
  if (!sourceBox || !boardBox) {
    throw new Error("Missing touch auto-scroll bounds");
  }
  const nativeTouch = await enableNativeTouch(page);

  await dispatchNativeTouch(nativeTouch, "touchStart", [source]);
  await expect(page.locator("[data-overlay]")).toHaveText("first");
  await dispatchNativeTouch(nativeTouch, "touchMove", [
    {
      clientX: sourceBox.x + sourceBox.width / 2,
      clientY: sourceBox.y + sourceBox.height - 2,
      id: source.id,
    },
  ]);
  await expect
    .poll(async () => await sourceCell.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await dispatchNativeTouch(nativeTouch, "touchMove", [
    {
      clientX: boardBox.x + boardBox.width - 2,
      clientY: boardBox.y + 40,
      id: source.id,
    },
  ]);
  await expect
    .poll(async () => await board.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  await endNativeTouch(nativeTouch);
});

test("drops a keyboard drag into an adjacent virtual cell", async ({
  page,
}) => {
  const handle = await openFixture(page);

  await handle.focus();
  await page.keyboard.press("Space");
  await expectDragActivated(page);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["draggedOver"] ?? "",
        ),
    )
    .toBe("cell-b");
  await page.keyboard.press("Space");

  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "",
        ),
    )
    .toBe("cell-b");
});

test("navigates items in order, then across matrix cells and lanes", async ({
  page,
}) => {
  const handle = await openFixture(page);

  await handle.focus();
  await page.keyboard.press("Space");
  await expectDragActivated(page);
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["draggedOver"] ?? "",
        ),
    )
    .toBe("third");
  await page.keyboard.press("Space");
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "",
        ),
    )
    .toBe("third");

  await page.reload();
  const reloadedHandle = page.getByRole("button", { name: "Move first" });
  await reloadedHandle.focus();
  await page.keyboard.press("Space");
  await expectDragActivated(page);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["draggedOver"] ?? "",
        ),
    )
    .toBe("cell-b");
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["draggedOver"] ?? "",
        ),
    )
    .toBe("second");
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

test("keyboard navigation reaches rows beyond the virtualizer window", async ({
  page,
}) => {
  const handle = await openFixture(page);
  const sourceCell = page.locator('[data-kanban-cell="cell-a"]');
  const targets = [
    "third",
    "fourth",
    "fifth",
    "sixth",
    ...Array.from({ length: 12 }, (_, index) => `virtual-${index + 1}`),
  ];

  await handle.focus();
  await page.keyboard.press("Space");
  const moveToTarget = async (index: number): Promise<void> => {
    const target = targets.at(index);
    if (target === undefined) {
      return;
    }
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => document.documentElement.dataset["draggedOver"] ?? "",
          ),
      )
      .toBe(target);
    await moveToTarget(index + 1);
  };
  await moveToTarget(0);
  await expect
    .poll(async () => await sourceCell.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Space");
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["droppedOn"] ?? "",
        ),
    )
    .toBe("virtual-12");
});
