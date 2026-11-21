import { request as playwrightRequest } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { apiGet, E2E_API_ORIGIN } from "../helpers/api";
import { signInWithEmailOtp } from "../helpers/sign-in";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

test("Lists renders and saves an item for a granted caller", async ({
  page,
  request,
}) => {
  const fixture = v.parse(
    v.object({ organizationId: v.string(), email: v.string() }),
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
  const sharedOrganizations = await request.get(
    `${E2E_API_ORIGIN}/api/auth/organization/list`,
  );
  expect(sharedOrganizations.ok(), await sharedOrganizations.text()).toBe(true);
  const organizationListSchema = v.array(v.object({ id: v.string() }));
  expect(
    v.parse(organizationListSchema, await sharedOrganizations.json()),
  ).not.toContainEqual({ id: fixture.organizationId });
  const api = await playwrightRequest.newContext({
    extraHTTPHeaders: {
      origin: new URL(
        test.info().project.use.baseURL ?? "http://localhost:3000",
      ).origin,
    },
  });
  try {
    await signInWithEmailOtp(api, fixture.email);
    const organizations = await api.get(
      `${E2E_API_ORIGIN}/api/auth/organization/list`,
    );
    expect(organizations.ok(), await organizations.text()).toBe(true);
    expect(v.parse(organizationListSchema, await organizations.json())).toEqual(
      [{ id: fixture.organizationId }],
    );
    const active = await api.post(
      `${E2E_API_ORIGIN}/api/auth/organization/set-active`,
      {
        data: { organizationId: fixture.organizationId },
      },
    );
    expect(active.ok(), await active.text()).toBe(true);
    const members = await api.get(
      `${E2E_API_ORIGIN}/api/auth/organization/list-members`,
      { params: { organizationId: fixture.organizationId } },
    );
    expect(members.ok(), await members.text()).toBe(true);
    expect(
      v.parse(
        v.object({
          total: v.number(),
          members: v.array(v.object({ user: v.object({ email: v.string() }) })),
        }),
        await members.json(),
      ),
    ).toEqual({ total: 1, members: [{ user: { email: fixture.email } }] });
    const workspace = await createTestWorkspace(api, "lists-journey");
    try {
      const state = await api.storageState();
      await page.context().clearCookies();
      await page.context().addCookies(state.cookies);
      const route = `/workspaces/${workspace.id}/lists`;
      await page.goto(route, { waitUntil: "commit" });
      const listsPage = page.getByRole("main");
      await expect(
        listsPage.getByRole("heading", { name: "Lists", exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${route}$`, "u"));
      const listName = listsPage
        .getByRole("complementary")
        .getByRole("textbox", { name: "Name", exact: true });
      await listName.fill("Review checklist");
      await listName.press("Enter");
      await expect(
        listsPage.getByRole("heading", {
          name: "Review checklist",
          exact: true,
        }),
      ).toBeVisible();
      const newItem = listsPage.getByRole("textbox", {
        name: "Add item",
        exact: true,
      });
      await newItem.fill("Confirm signing date");
      await newItem.press("Enter");
      const savedItem = listsPage
        .getByRole("table")
        .getByRole("button", { name: "Confirm signing date", exact: true });
      await expect(savedItem).toBeVisible();
      await page.reload({ waitUntil: "commit" });
      await expect(savedItem).toBeVisible();
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
