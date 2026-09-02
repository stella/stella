import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

test("authenticated law pages retain the user's recent matters", async ({
  page,
  request,
}) => {
  const label = "law-sidebar";
  const workspace = await createTestWorkspace(request, label);
  const workspaceName = `${label}-${workspace.id.slice(0, 8)}`;

  try {
    // /law is the law entry; it scopes itself to a jurisdiction on arrival.
    await page.goto("/law", { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/law(?:[/?#]|$)/u);
    await expect(
      page
        .locator('[data-slot="sidebar"]')
        .getByText(workspaceName, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await deleteTestWorkspace(request, workspace.id);
  }
});
