import { apiGet, apiPut, apiStatus } from "../helpers/api";
import { seedSidebarState } from "../helpers/sidebar-state";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

for (const kind of ["document", "task"] as const) {
  test(`sidebar ${kind} actions delete only the child`, async ({
    baseURL,
    page,
    request,
  }, testInfo) => {
    const workspace = await createTestWorkspace(request, "sidebar-actions");
    const name = `Sidebar ${kind}`;
    try {
      const child = await apiPut<{ entityId: string }>(
        request,
        kind === "task"
          ? `/tasks/${workspace.id}`
          : `/entities/${workspace.id}`,
        kind === "task" ? { name } : { kind, name },
      );
      const sibling = await apiPut<{ entityId: string }>(
        request,
        `/tasks/${workspace.id}`,
        { name: "Untouched sibling" },
      );
      await page.context().addCookies((await request.storageState()).cookies);
      await seedSidebarState({
        baseURL,
        context: page.context(),
        state: "expanded",
      });
      await page.goto(`/workspaces/${workspace.id}/${workspace.viewId}`, {
        waitUntil: "domcontentloaded",
      });
      const sidebar = page.locator('[data-slot="sidebar"]');
      const disclosure = sidebar.locator(
        `button[aria-controls="matter-activity-${workspace.id}"]`,
      );
      await expect(disclosure).toBeVisible();
      if ((await disclosure.getAttribute("aria-expanded")) === "false") {
        await disclosure.click();
      }
      const row = sidebar
        .locator('[data-slot="sidebar-menu-sub-item"]')
        .filter({ has: page.getByText(name, { exact: true }) });
      await expect(row).toBeVisible();
      await row.getByText(name, { exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { exact: true, name: "Delete" }).click();
      const confirmation = page.getByRole("alertdialog");
      await expect(confirmation).toContainText(name);
      const deleted = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          new URL(response.url()).pathname === `/v1/entities/${workspace.id}`,
      );
      await confirmation
        .getByRole("button", { exact: true, name: "Delete" })
        .click();
      const response = await deleted;
      expect(response.ok()).toBe(true);
      expect(response.request().postDataJSON()).toEqual({
        entityIds: [child.entityId],
      });
      expect(
        await apiStatus(
          request,
          `/entities/${workspace.id}/entity/${child.entityId}`,
        ),
      ).toBe(404);
      expect(await apiStatus(request, `/workspaces/${workspace.id}`)).toBe(200);
      expect(
        await apiGet<{ name: string }>(
          request,
          `/entities/${workspace.id}/entity/${sibling.entityId}`,
        ),
      ).toMatchObject({ name: "Untouched sibling" });
    } finally {
      await deleteTestWorkspace(request, workspace.id, {
        leave: { page, testInfo },
      });
    }
  });
}

test("context menus return focus to sidebar rows and matter cards", async ({
  baseURL,
  page,
  request,
}, testInfo) => {
  const workspace = await createTestWorkspace(request, "menu-focus");
  const childName = "Focus return document";
  const taskName = "Focus return task";
  const workspaceName = `menu-focus-${workspace.id.slice(0, 8)}`;
  try {
    await apiPut(request, `/entities/${workspace.id}`, {
      kind: "document",
      name: childName,
    });
    await apiPut(request, `/tasks/${workspace.id}`, { name: taskName });
    await page.context().addCookies((await request.storageState()).cookies);
    await seedSidebarState({
      baseURL,
      context: page.context(),
      state: "expanded",
    });
    await page.goto(`/workspaces/${workspace.id}/${workspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });

    const sidebar = page.locator('[data-slot="sidebar"]');
    const disclosure = sidebar.locator(
      `button[aria-controls="matter-activity-${workspace.id}"]`,
    );
    await expect(disclosure).toBeVisible();
    if ((await disclosure.getAttribute("aria-expanded")) === "false") {
      await disclosure.click();
    }
    const sidebarOpener = sidebar.getByRole("button", {
      exact: true,
      name: childName,
    });
    await sidebarOpener.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sidebarOpener).toBeFocused();

    const upcoming = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Upcoming agenda", exact: true }),
    });
    const overviewOpener = upcoming.getByRole("button", {
      exact: true,
      name: taskName,
    });
    await expect(overviewOpener).toBeVisible();
    await overviewOpener.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(overviewOpener).toBeFocused();

    await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
    const cardOpener = page.getByRole("link", {
      exact: true,
      name: workspaceName,
    });
    await expect(cardOpener).toBeVisible();
    await cardOpener.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(cardOpener).toBeFocused();
  } finally {
    await deleteTestWorkspace(request, workspace.id, {
      leave: { page, testInfo },
    });
  }
});
