import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

// A phone-sized, touch viewport: below `md` the sidebar is a sheet over the
// page rather than a column beside it.
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test("phone sidebar closes once a matter it opened has loaded", async ({
  page,
  request,
}, testInfo) => {
  const label = "mobile-sidebar-navigation";
  const workspace = await createTestWorkspace(request, label);
  const workspaceName = `${label}-${workspace.id.slice(0, 8)}`;

  try {
    // Visit the matter once so it is listed among the sidebar's recents.
    await page.goto(`/workspaces/${workspace.id}/${workspace.viewId}`, {
      waitUntil: "commit",
    });
    await expect(page.getByText(workspaceName).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.goto("/contacts", { waitUntil: "commit" });

    const sheet = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    await page.locator('[data-sidebar="trigger"]').first().tap();
    await expect(sheet).toBeVisible();

    await sheet.getByRole("link", { name: workspaceName }).tap();

    await expect(page).toHaveURL(
      new RegExp(`/workspaces/${workspace.id}(/|$)`, "u"),
    );
    await expect(sheet).toBeHidden();
  } finally {
    await deleteTestWorkspace(request, workspace.id, {
      leave: { page, testInfo },
    });
  }
});
