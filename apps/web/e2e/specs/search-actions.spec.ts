import type { Page } from "@playwright/test";

import { apiStatus } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const openSearch = async (page: Page, route = "/workspaces") => {
  await page.goto(route, { waitUntil: "commit" });
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({
    timeout: 30_000,
  });

  const modifier = await page.evaluate(() =>
    navigator.platform.includes("Mac") ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);

  const input = page.getByRole("combobox").first();
  await expect(input).toBeVisible({ timeout: 30_000 });
  return input;
};

const assertActionsAboveFold = async (page: Page) => {
  const actionRows = page.locator("[data-command-action-id]");
  await expect(actionRows.first()).toBeVisible();

  const bounds = await Promise.all([
    page.getByRole("listbox").evaluate((list) => {
      const { bottom, top } = list.getBoundingClientRect();
      return {
        bottom,
        top,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      };
    }),
    actionRows.evaluateAll((rows) =>
      rows.map((row) => {
        const { bottom, top } = row.getBoundingClientRect();
        return { bottom, top };
      }),
    ),
  ]);
  const listBounds = bounds[0];
  const rowBounds = bounds[1];
  expect(rowBounds.length).toBeGreaterThan(0);
  expect(listBounds.scrollHeight).toBe(listBounds.clientHeight);
  const lastAction = rowBounds.at(-1);
  expect(lastAction?.bottom).toBeGreaterThan(listBounds.bottom - 32);
  expect(
    rowBounds.every(
      ({ bottom, top }) => top >= listBounds.top && bottom <= listBounds.bottom,
    ),
  ).toBe(true);
};

for (const locale of ["en", "ar"] as const) {
  test.describe(`search actions (${locale})`, () => {
    test.use({ locale });

    test("empty search exposes actions without scrolling", async ({ page }) => {
      const input = await openSearch(page);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute(
        "dir",
        locale === "ar" ? "rtl" : "ltr",
      );
      await assertActionsAboveFold(page);
      await expect(input).toHaveValue("");
    });
  });
}

for (const locale of ["en", "ar"] as const) {
  test.describe(`localized action keyboard selection (${locale})`, () => {
    test.use({ locale });

    test("remains selectable after filtering", async ({ page }) => {
      const input = await openSearch(page);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute(
        "dir",
        locale === "ar" ? "rtl" : "ltr",
      );
      const newMatterRow = page.locator(
        '[data-search-empty-row][data-command-action-id="new-matter"]',
      );
      await expect(newMatterRow).toBeVisible();
      const title =
        (await newMatterRow.locator("span").first().textContent())?.trim() ??
        "";
      expect(title).not.toBe("");

      await input.fill(title);
      await expect(
        page.getByRole("option").filter({ hasText: title }),
      ).toBeVisible();
      await input.press("ArrowDown");
      await page.keyboard.press("Enter");

      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
    });
  });
}

test("filtered new-chat action opens an inspector chat", async ({ page }) => {
  const input = await openSearch(page, "/chat");
  const actionRow = page.locator(
    '[data-search-empty-row][data-command-action-id="new-chat"]',
  );
  await expect(actionRow).toBeVisible();
  const title =
    (await actionRow.locator("span").first().textContent())?.trim() ?? "";

  await input.fill(title);
  await input.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(
    page.locator('[data-slot="inspector-chat-panel"]'),
  ).toBeVisible();
});

test.describe("global create actions", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "search-actions");
  });

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }
    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("upload-document opens with a matter selector outside a matter", async ({
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }
    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        { timeout: 10_000 },
      )
      .toBe(200);

    const input = await openSearch(page);
    const action = page.locator(
      '[data-search-empty-row][data-command-action-id="upload-document"]',
    );
    await expect(action).toBeVisible();
    await input.fill(
      (await action.locator("span").first().textContent())?.trim() ?? "",
    );
    await input.press("ArrowDown");
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const matterPicker = dialog.getByRole("combobox");
    await expect(matterPicker).toBeVisible();
    await matterPicker.click();
    const matterOption = page.getByRole("option", {
      name: `search-actions-${testWorkspace.id.slice(0, 8)}`,
    });
    await expect(matterOption).toBeVisible();
    await matterOption.click();
    await expect(
      dialog.getByText("Upload files", { exact: true }),
    ).toBeVisible();
  });

  test("new-task is absent outside a matter", async ({ page }) => {
    const input = await openSearch(page);
    await expect(
      page.locator(
        '[data-search-empty-row][data-command-action-id="new-task"]',
      ),
    ).toHaveCount(0);
    await expect(input).toHaveValue("");
  });

  test("matter actions create a task and keep upload scoped to the current matter", async ({
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }
    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({
      timeout: 30_000,
    });

    const input = await openSearch(page, `/workspaces/${testWorkspace.id}`);
    const taskAction = page.locator(
      '[data-search-empty-row][data-command-action-id="new-task"]',
    );
    await expect(taskAction).toBeVisible();
    await input.fill(
      (await taskAction.locator("span").first().textContent())?.trim() ?? "",
    );
    await input.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByPlaceholder("Untitled task")).toBeVisible({
      timeout: 30_000,
    });

    const uploadInput = await openSearch(
      page,
      `/workspaces/${testWorkspace.id}`,
    );
    const uploadAction = page.locator(
      '[data-search-empty-row][data-command-action-id="upload-document"]',
    );
    await expect(uploadAction).toBeVisible();
    await uploadInput.fill(
      (await uploadAction.locator("span").first().textContent())?.trim() ?? "",
    );
    await uploadInput.press("ArrowDown");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    await expect(
      dialog.getByText(`search-actions-${testWorkspace.id.slice(0, 8)}`),
    ).toBeVisible();
  });
});
