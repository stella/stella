import { expect } from "@playwright/test";

import { apiPut } from "../../helpers/api";
import { deleteTestWorkspace } from "../../helpers/workspace";
import type { DriveScriptContext } from "../drive-context";
import { createLegalMatter } from "./fixture-setup";

const runSearchCensus = async ({ page, measureAction }: DriveScriptContext) => {
  const name = "Smluvní podmínky předání technologického vybavení";
  const matter = await createLegalMatter(page.request, name);
  const documentName = "Předávací protokol technologického vybavení";
  try {
    await apiPut(page.request, `/entities/${matter.id}`, {
      name: documentName,
      kind: "document",
    });
    await page.goto("/law/cases?country=cze", {
      waitUntil: "domcontentloaded",
    });
    const result = page.locator('main a[href^="/law/cze/cases/"]').first();
    await measureAction("search: Czech case query", async () => {
      const input = page.getByPlaceholder(
        "Case number, ECLI or words, e.g. 22 Cdo 2653/2012",
      );
      await input.pressSequentially("fiktivní");
      await input.press("Enter");
      await expect(result).toBeVisible({ timeout: 30_000 });
    });
    await measureAction("search: open case result", async () => {
      await result.click();
      await expect(page.locator(".reader-scroll article")).toBeVisible();
    });
    await measureAction("search: back to results", async () => {
      await page.goBack();
      await expect(result).toBeVisible();
    });
    await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
    await measureAction("search: open in-app search", async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("combobox").first()).toBeVisible();
    });
    await measureAction("search: find a matter", async () => {
      await page
        .getByRole("combobox")
        .first()
        .pressSequentially("smluvní podmínky");
      await expect(
        page.getByRole("listbox").getByText(name, { exact: true }),
      ).toBeVisible();
    });
    await measureAction("search: find a document", async () => {
      const input = page.getByRole("combobox").first();
      await input.press("ControlOrMeta+a");
      await input.pressSequentially(documentName);
      await expect(
        page.getByRole("listbox").getByText(documentName, { exact: true }),
      ).toBeVisible();
    });
  } finally {
    await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
    await deleteTestWorkspace(page.request, matter.id);
  }
};

export default runSearchCensus;
