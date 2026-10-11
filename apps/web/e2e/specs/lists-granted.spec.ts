import { request as playwrightRequest } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { E2E_API_ORIGIN, apiGet } from "../helpers/api";
import { signInWithEmailOtp } from "../helpers/sign-in";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

test("Lists renders and saves an item for a granted caller", async ({
  page,
}) => {
  const fixture = v.parse(
    v.object({ organizationId: v.string() }),
    JSON.parse(
      await readFile(
        path.resolve(
          import.meta.dirname,
          "../../../../.playwright/feature-access.json",
        ),
        "utf-8",
      ),
    ),
  );
  const api = await playwrightRequest.newContext({
    extraHTTPHeaders: {
      origin: new URL(
        test.info().project.use.baseURL ?? "http://localhost:3000",
      ).origin,
    },
  });
  try {
    await signInWithEmailOtp(api, "test@stella.dev");
    const active = await api.post(
      `${E2E_API_ORIGIN}/api/auth/organization/set-active`,
      {
        data: { organizationId: fixture.organizationId },
      },
    );
    expect(active.ok(), await active.text()).toBe(true);
    const workspace = await createTestWorkspace(api, "lists-journey");
    try {
      const state = await api.storageState();
      await page.context().clearCookies();
      await page.context().addCookies(state.cookies);
      const route = `/workspaces/${workspace.id}/lists`;
      await page.goto(route, { waitUntil: "commit" });
      await expect(
        page.getByRole("heading", { name: "Lists", exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${route}$`, "u"));
      await page
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("Review checklist");
      await page
        .getByRole("textbox", { name: "Name", exact: true })
        .press("Enter");
      await expect(
        page.getByRole("heading", { name: "Review checklist", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: "Add item", exact: true })
        .fill("Confirm signing date");
      await page
        .getByRole("textbox", { name: "Add item", exact: true })
        .press("Enter");
      await expect(
        page.getByText("Confirm signing date", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("Confirm signing date", { exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${route}\\?list=`, "u"));
      const lists = await apiGet<{ items: { id: string; name: string }[] }>(
        api,
        `/lists/${workspace.id}`,
      );
      expect(lists.items).toContainEqual(
        expect.objectContaining({ name: "Review checklist" }),
      );
    } finally {
      await deleteTestWorkspace(api, workspace.id);
    }
  } finally {
    await api.dispose();
  }
});
