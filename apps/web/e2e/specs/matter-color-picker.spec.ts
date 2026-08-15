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
    const matterLink = sidebar.getByRole("link", {
      name: new RegExp(workspaceName, "u"),
    });
    await expect(matterLink).toBeVisible({ timeout: 30_000 });

    const colorTrigger = matterLink.locator("span").first();
    await colorTrigger.click({ button: "right" });
    await expect(
      colorTrigger.locator('[class~="animate-attention-flash"]'),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Show more" }).click();

    await expect(
      page.getByRole("textbox", { name: "Custom hex color" }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/workspaces/${workspace.id}/${workspace.viewId}$`, "u"),
    );
  } finally {
    await deleteTestWorkspace(request, workspace.id);
  }
});
