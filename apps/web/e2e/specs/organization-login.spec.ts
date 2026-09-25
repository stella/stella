import { request as playwrightRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { signInWithEmailOtp } from "../helpers/sign-in";
import { expect, test } from "../helpers/test";

const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";

const createOrganizationSelectionSession = async ({
  email,
  primaryOrganization,
  secondaryOrganization,
}: {
  email: string;
  primaryOrganization: { name: string; slug: string };
  secondaryOrganization: { name: string; slug: string };
}) => {
  const requestOptions = {
    extraHTTPHeaders: { origin: new URL(WEB_BASE_URL).origin },
  };
  const loginApi = await playwrightRequest.newContext(requestOptions);
  try {
    await signInWithEmailOtp(loginApi, email);
    // Creating an organization activates it and refreshes the cached session
    // cookie. Preserve the signed pre-create snapshot, then create two real
    // memberships so the route shows its picker instead of auto-selecting the
    // sole organization.
    const storageStateWithoutActiveOrganization = await loginApi.storageState();
    const primaryCreateResponse = await loginApi.post(
      `${API_BASE_URL}/api/auth/organization/create`,
      { data: primaryOrganization },
    );
    expect(primaryCreateResponse.ok(), await primaryCreateResponse.text()).toBe(
      true,
    );
    const secondaryCreateResponse = await loginApi.post(
      `${API_BASE_URL}/api/auth/organization/create`,
      { data: secondaryOrganization },
    );
    expect(
      secondaryCreateResponse.ok(),
      await secondaryCreateResponse.text(),
    ).toBe(true);
    return storageStateWithoutActiveOrganization;
  } finally {
    await loginApi.dispose();
  }
};

test("selecting an organization completes login and renders the destination", async ({
  page,
}) => {
  const testToken = randomUUID().slice(0, 8);
  const organizationName = `Northbridge Legal ${testToken}`;
  const storageState = await createOrganizationSelectionSession({
    email: `organization-login-${testToken}@stella.dev`,
    primaryOrganization: {
      name: organizationName,
      slug: `northbridge-legal-${testToken}`,
    },
    secondaryOrganization: {
      name: `Northbridge Support ${testToken}`,
      slug: `northbridge-support-${testToken}`,
    },
  });
  await page.context().clearCookies();
  await page.context().addCookies(storageState.cookies);

  await page.goto("/auth/organization?redirectTo=%2Fchat", {
    waitUntil: "commit",
  });
  const organization = page.getByRole("button", {
    name: organizationName,
  });
  await expect(organization).toBeVisible({ timeout: 30_000 });
  await organization.click();

  await expect(page).toHaveURL(/\/chat\/?$/u, { timeout: 30_000 });
  await expect(
    page.getByRole("textbox", { name: /type your question/iu }),
  ).toBeVisible({ timeout: 30_000 });
});
