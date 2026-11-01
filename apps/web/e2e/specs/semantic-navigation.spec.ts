import type { Locator, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { apiDelete, apiPut } from "../helpers/api";
import { seedSidebarState } from "../helpers/sidebar-state";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

const semanticStructure = async (page: Page) =>
  await page.evaluate(() => ({
    mainCount: document.querySelectorAll('main, [role="main"]').length,
    nestedMainCount: document.querySelectorAll("main main").length,
    invalidListChildren: [
      ...document.querySelectorAll('[data-slot="sidebar"] ul'),
    ].flatMap((list) =>
      [...list.children]
        .filter((child) => child.tagName !== "LI")
        .map((child) => child.tagName),
    ),
  }));

const validStructure = {
  mainCount: 1,
  nestedMainCount: 0,
  invalidListChildren: [],
};

const focusedElementProblems = async (page: Page) =>
  await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) {
      return [];
    }
    const problems: string[] = [];
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      !element.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      })
    ) {
      problems.push("invisible");
    }
    if (bounds.width <= 1 || bounds.height <= 1) {
      problems.push("no visible focus target");
    }
    if (style.clipPath === "inset(50%)") {
      problems.push("clipped focus target");
    }
    if (element.closest('[aria-hidden="true"], [inert]')) {
      problems.push("hidden from assistive technology");
    }
    return problems;
  });

const assertVisibleTabTargets = async (page: Page) => {
  const targetCount = await page.evaluate(
    () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          "a[href], button, input, select, textarea, [tabindex], [contenteditable]",
        ),
      ].filter((element) => element.tabIndex >= 0).length,
  );
  expect(targetCount).toBeGreaterThan(0);
  for (let index = 0; index < targetCount + 2; index += 1) {
    await page.keyboard.press("Tab");
    await expect
      .poll(async () => await focusedElementProblems(page), {
        message: `Tab stop ${index + 1} must disclose a visible focus target`,
      })
      .toEqual([]);
  }
};

const blankCellPoint = async (cell: Locator) =>
  await cell.evaluate(async (element) => {
    const margin = 8;
    const rectValues = (rect: DOMRect) => [
      rect.left,
      rect.top,
      rect.right,
      rect.bottom,
    ];
    const nextFrameRect = async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      return element.getBoundingClientRect();
    };

    let cellRect = await nextFrameRect();
    // real-time: layout stability can only be observed across rendered frames.
    while (true) {
      const nextRect = await nextFrameRect();
      if (
        rectValues(cellRect).every(
          (value, index) => value === rectValues(nextRect)[index],
        )
      ) {
        cellRect = nextRect;
        break;
      }
      cellRect = nextRect;
    }
    // A virtualized row can replace its cell while the frames settle; a
    // detached or unsized cell has no point to click, so the caller retries
    // with a freshly resolved cell.
    if (!element.isConnected || cellRect.width === 0 || cellRect.height === 0) {
      return null;
    }

    const y = cellRect.top + cellRect.height / 2;
    const linkRects = [...element.querySelectorAll("a")].flatMap((link) =>
      [...link.getClientRects()].map((rect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      })),
    );
    const blocked = linkRects
      .filter((rect) => y >= rect.top - margin && y <= rect.bottom + margin)
      .map((rect) => ({
        left: Math.max(cellRect.left + margin, rect.left - margin),
        right: Math.min(cellRect.right - margin, rect.right + margin),
      }))
      .filter((interval) => interval.left < interval.right)
      .toSorted((first, second) => first.left - second.left);
    const available: { left: number; right: number }[] = [];
    let start = cellRect.left + margin;
    for (const interval of blocked) {
      if (interval.left > start) {
        available.push({ left: start, right: interval.left });
      }
      start = Math.max(start, interval.right);
    }
    if (start < cellRect.right - margin) {
      available.push({ left: start, right: cellRect.right - margin });
    }
    const widest = available
      .filter((interval) => interval.right - interval.left >= margin)
      .toSorted(
        (first, second) =>
          second.right - second.left - (first.right - first.left),
      )
      .at(0);
    if (widest === undefined) {
      throw new Error(
        `No 8px blank interval in email cell ${JSON.stringify(rectValues(cellRect))}; link rects: ${JSON.stringify(linkRects)}`,
      );
    }
    const x = (widest.left + widest.right) / 2;
    const target = document.elementFromPoint(x, y);
    const point = { x: x - cellRect.left, y: y - cellRect.top };
    if (target === null) {
      return { ...point, hit: "outside-viewport" };
    }
    return {
      ...point,
      hit: target.closest("a") === null ? "cell-space" : "link",
    };
  });

const MAX_CELL_RESOLUTIONS = 20;

const renderedBlankCellPoint = async (cell: Locator) => {
  // real-time: each attempt re-resolves the locator and waits for rendered
  // frames, so a replaced cell is measured once the new one is laid out.
  for (let attempt = 0; attempt < MAX_CELL_RESOLUTIONS; attempt += 1) {
    const point = await blankCellPoint(cell);
    if (point !== null) {
      return point;
    }
  }
  throw new Error(
    `Email cell stayed detached or unsized across ${MAX_CELL_RESOLUTIONS} resolutions`,
  );
};

test.describe("focus target detector", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("rejects clipped anchors while accepting visible controls", async ({
    page,
  }) => {
    await page.setContent(`
    <button id="visible">Visible action</button>
    <span id="anchor" role="button" tabindex="0"
      style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)"></span>
  `);
    await page.locator("#visible").focus();
    expect(await focusedElementProblems(page)).toEqual([]);
    await page.keyboard.press("Tab");
    await expect(page.locator("#anchor")).toBeFocused();
    expect(await focusedElementProblems(page)).toContain(
      "clipped focus target",
    );
  });

  test("detects nested landmarks and list wrappers", async ({ page }) => {
    await page.setContent(`
      <main><main>Settings</main></main>
      <aside data-slot="sidebar"><ul><div class="contents"><li>Matter</li></div></ul></aside>
    `);
    expect(await semanticStructure(page)).toEqual({
      mainCount: 2,
      nestedMainCount: 1,
      invalidListChildren: ["DIV"],
    });
    await page.setContent(`
      <main><section>Settings</section></main>
      <aside data-slot="sidebar"><ul><li>Matter</li></ul></aside>
    `);
    expect(await semanticStructure(page)).toEqual(validStructure);
  });
});

for (const scope of ["matters", "matter", "settings"] as const) {
  test(`${scope} exposes one main landmark, valid sidebar lists and visible tab stops`, async ({
    baseURL,
    page,
    request,
  }, testInfo) => {
    const workspace = await createTestWorkspace(request, "semantic-navigation");
    try {
      await page.context().addCookies((await request.storageState()).cookies);
      await seedSidebarState({
        baseURL,
        context: page.context(),
        state: "expanded",
      });
      const paths = {
        matters: "/workspaces",
        matter: `/workspaces/${workspace.id}/${workspace.viewId}`,
        settings: "/settings/account/profile",
      };
      await page.goto(paths[scope], { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("main")).toHaveCount(1);
      await expect(page.getByRole("main")).toBeVisible();
      expect(await semanticStructure(page)).toEqual(validStructure);
      await assertVisibleTabTargets(page);
    } finally {
      await deleteTestWorkspace(request, workspace.id, {
        leave: { page, testInfo },
      });
    }
  });
}

test("closing New matter returns focus to its opener on cancel and Escape", async ({
  page,
}) => {
  await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
  const opener = page
    .getByRole("main")
    .getByRole("button", { exact: true, name: "New matter" });
  await expect(opener).toBeEnabled();
  for (const close of ["cancel", "escape"] as const) {
    await opener.click();
    const dialog = page.getByRole("dialog", {
      exact: true,
      name: "New matter",
    });
    await expect(dialog).toBeVisible();
    if (close === "cancel") {
      await dialog.getByRole("button", { exact: true, name: "Cancel" }).click();
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
  }
});

for (const email of [null, "a@example.test"]) {
  test(`contact email cell space opens the contact (${email === null ? "empty" : "with address"})`, async ({
    page,
    request,
  }, testInfo) => {
    const contactId = randomUUID();
    const displayName = `Contact click ${contactId.slice(0, 8)}`;
    await apiPut(request, "/contacts", {
      id: contactId,
      type: "person",
      displayName,
      ...(email === null
        ? {}
        : {
            emails: [{ type: "work", address: email, isPrimary: true }],
          }),
    });
    try {
      await page.context().addCookies((await request.storageState()).cookies);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/contacts", { waitUntil: "domcontentloaded" });
      // The unfiltered list can already show the new contact; the debounced
      // search then replaces its rows, so wait for the filtered page first.
      const filtered = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.pathname.endsWith("/contacts") &&
          url.searchParams.get("q") === displayName
        );
      });
      await page
        .getByRole("searchbox", { name: "Search contacts" })
        .fill(displayName);
      expect((await filtered).ok()).toBe(true);
      const row = page.getByRole("row").filter({
        has: page.getByRole("link", { exact: true, name: displayName }),
      });
      await expect(row).toBeVisible();
      const emailColumn = await page
        .getByRole("columnheader", { exact: true, name: "Email" })
        .evaluate((header) =>
          header instanceof HTMLTableCellElement ? header.cellIndex : -1,
        );
      expect(emailColumn).toBeGreaterThanOrEqual(0);
      const cell = row.getByRole("cell").nth(emailColumn);
      if (email !== null) {
        const link = cell.getByRole("link", { exact: true, name: email });
        await expect(link).toHaveAttribute("href", `mailto:${email}`);
        // Keep the browser in the test while preserving the app's event bubbling.
        await link.evaluate((element) => {
          element.addEventListener("click", (event) => event.preventDefault(), {
            once: true,
          });
        });
        await link.click();
        await expect(page).toHaveURL(/\/contacts$/u);
      }
      // elementFromPoint answers null outside the viewport; a wide table can
      // leave the email column's edge off screen.
      await cell.scrollIntoViewIfNeeded();
      const space = await renderedBlankCellPoint(cell);
      expect(space.hit).toBe("cell-space");
      await cell.click({ position: { x: space.x, y: space.y } });
      await expect(page).toHaveURL(new RegExp(`/contacts/${contactId}$`, "u"));
    } finally {
      if (testInfo.status === testInfo.expectedStatus) {
        await page.goto("about:blank", { waitUntil: "commit" });
      }
      await apiDelete(request, `/contacts/${contactId}`);
    }
  });
}
