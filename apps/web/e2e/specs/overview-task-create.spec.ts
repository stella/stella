import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

test("double-clicking Add creates one upcoming task", async ({
  page,
  request,
}, testInfo) => {
  const workspace = await createTestWorkspace(request, "overview-task-create");
  const release = Promise.withResolvers<undefined>();
  let creates = 0;
  await page.route(`**/tasks/${workspace.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    creates += 1;
    await release.promise;
    await route.continue();
  });

  try {
    await page.goto(`/workspaces/${workspace.id}`, { waitUntil: "commit" });
    const upcoming = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Upcoming agenda", exact: true }),
    });
    const add = upcoming.getByRole("button", { name: "Add", exact: true });
    await expect(add).toBeVisible({
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });
    await add.dblclick();
    await expect.poll(() => creates).toBeGreaterThan(0);
    expect(creates).toBe(1);
    await expect(add).toBeDisabled();
    release.resolve(undefined);
    await expect(page.getByText("Task created", { exact: true })).toBeVisible();
    await expect(
      upcoming.getByRole("button", { name: "Untitled task" }),
    ).toHaveCount(1);
    expect(creates).toBe(1);
  } finally {
    release.resolve(undefined);
    await page.unrouteAll({ behavior: "wait" });
    await deleteTestWorkspace(request, workspace.id, {
      leave: { page, testInfo },
    });
  }
});
