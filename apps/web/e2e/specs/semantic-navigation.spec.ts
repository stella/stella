import type { Page } from "@playwright/test";
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
    if (style.clip !== "auto" || style.clipPath === "inset(50%)") {
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

test.describe("focus target detector", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("rejects clipped anchors while accepting visible controls", async ({
    page,
  }) => {
    await page.setContent(`
    <button id="visible">Visible action</button>
    <span id="anchor" role="button" tabindex="0"
      style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"></span>
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
      await page
        .getByRole("textbox", { name: "Search contacts" })
        .fill(displayName);
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
      const space = await cell.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const x = bounds.width - 4;
        const y = bounds.height / 2;
        const target = document.elementFromPoint(
          bounds.left + x,
          bounds.top + y,
        );
        return { x, y, hitsLink: target?.closest("a") !== null };
      });
      expect(space.hitsLink).toBe(false);
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
