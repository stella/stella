import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

test("sidebar color picker stays open when custom colors are expanded", async ({
  page,
  request,
}) => {
  const label = "matter-color-picker";
  const workspace = await createTestWorkspace(request, label);
  const workspaceName = `${label}-${workspace.id.slice(0, 8)}`;

  try {
    await page.goto(`/workspaces/${workspace.id}/${workspace.viewId}`, {
      waitUntil: "commit",
    });

    const sidebar = page.locator('[data-sidebar="sidebar"]');
    const matterItem = sidebar
      .locator('[data-sidebar="menu-item"]')
      .filter({ hasText: workspaceName });
    const matterLink = matterItem.getByRole("link", { name: workspaceName });
    await expect(matterLink).toBeVisible({ timeout: 30_000 });

    const colorTrigger = matterItem.getByRole("button", {
      name: "Change color",
    });
    const colorPicker = page.locator('[data-slot="color-picker"]');

    await colorTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(colorPicker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(colorPicker).toBeHidden();

    await colorTrigger.click({ button: "right" });
    await expect(
      colorTrigger.locator('[class~="animate-attention-flash"]'),
    ).toHaveCount(1);
    await colorPicker.getByRole("button", { name: "Show more" }).click();

    const customColorInput = page.getByRole("textbox", {
      name: "Custom hex color",
    });
    await expect(customColorInput).toBeVisible();

    const colorUpdate = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/workspaces/${workspace.id}`),
    );
    await customColorInput.fill("12AB34");
    const colorUpdateResponse = await colorUpdate;
    expect(colorUpdateResponse.ok()).toBe(true);

    await expect(customColorInput).toHaveValue("12AB34");
    await expect(customColorInput).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/workspaces/${workspace.id}/${workspace.viewId}$`, "u"),
    );
  } finally {
    await deleteTestWorkspace(request, workspace.id);
  }
});
