import { request as playwrightRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { E2E_API_ORIGIN } from "../helpers/api";
import { signInWithEmailOtp } from "../helpers/sign-in";
import { expect, test } from "../helpers/test";

const createSignedInAccount = async () => {
  const api = await playwrightRequest.newContext({
    extraHTTPHeaders: { origin: "http://localhost:3000" },
  });
  const suffix = randomUUID().slice(0, 8);
  await signInWithEmailOtp(api, `professional-use-${suffix}@stella.dev`);
  const organization = await api.post(
    `${E2E_API_ORIGIN}/api/auth/organization/create`,
    { data: { name: `Professional Use ${suffix}`, slug: `pro-use-${suffix}` } },
  );
  expect(organization.ok(), await organization.text()).toBe(true);
  return api;
};

test("an account awaiting confirmation sees the statement and enters the product after accepting", async ({
  page,
}) => {
  const api = await createSignedInAccount();
  try {
    await page.context().addCookies((await api.storageState()).cookies);
    let accepted = false;
    await page.route("**/v1/me/professional-use", async (route) => {
      if (route.request().method() === "POST") {
        accepted = true;
      }
      await route.fulfill({
        json: { status: accepted ? "accepted" : "required" },
      });
    });

    await page.goto("/workspaces");
    await expect(
      page.getByRole("heading", { name: "Confirm professional use" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "You confirm that you use stella for professional purposes and understand that stella is a tool for legal professionals and not a substitute for legal advice.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page).toHaveURL(/\/workspaces\/?$/u);
    await expect(
      page.getByRole("heading", { name: "Confirm professional use" }),
    ).not.toBeVisible();
  } finally {
    await api.dispose();
  }
});

test("an account with a recorded acceptance enters the product without the card", async ({
  page,
}) => {
  const api = await createSignedInAccount();
  try {
    await page.context().addCookies((await api.storageState()).cookies);
    await page.goto("/workspaces");
    await expect(page).toHaveURL(/\/workspaces\/?$/u);
    await expect(
      page.getByRole("heading", { name: "Confirm professional use" }),
    ).not.toBeVisible();
  } finally {
    await api.dispose();
  }
});
