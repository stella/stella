import { expect } from "@playwright/test";

import { deleteTestWorkspace } from "../../helpers/workspace";
import type { DriveScriptContext } from "../drive-context";
import { createLegalMatter } from "./fixture-setup";

const runMatterCensus = async ({ page, measureAction }: DriveScriptContext) => {
  const name = "Převzetí areálu – posouzení smluvních podmínek";
  const created = await createLegalMatter(page.request, name);
  try {
    await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
    const matter = page.getByRole("row").filter({ hasText: name });
    await expect(matter).toBeVisible({ timeout: 30_000 });
    await measureAction("matter: open from matters", async () => {
      await matter.click();
      await expect(page.getByRole("tab").first()).toBeVisible();
    });
    // Capture labels before navigating: inactive views can unmount their content.
    const labels = await page.getByRole("tab").allTextContents();
    for (const label of labels) {
      const tabName = label.trim();
      await measureAction(`matter: tab ${tabName}`, async () => {
        const tab = page.getByRole("tab", { name: tabName, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
      });
    }
  } finally {
    await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
    await deleteTestWorkspace(page.request, created.id);
  }
};

export default runMatterCensus;
