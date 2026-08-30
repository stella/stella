import {
  type APIRequestContext,
  request as playwrightRequest,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

import { expect, test } from "../helpers/test";

const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";

const signIn = async (api: APIRequestContext, email: string) => {
  const sendResponse = await api.post(
    `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
    { data: { email, type: "sign-in" } },
  );
  expect(sendResponse.ok(), await sendResponse.text()).toBe(true);

  const otpResponse = await api.get(
    `${API_BASE_URL}/dev-public/last-otp?email=${encodeURIComponent(email)}`,
  );
  expect(otpResponse.ok(), await otpResponse.text()).toBe(true);
  const otpPayload: unknown = await otpResponse.json();
  expect(
    typeof otpPayload === "object" &&
      otpPayload !== null &&
      "otp" in otpPayload &&
      typeof otpPayload.otp === "string",
  ).toBe(true);
  if (
    typeof otpPayload !== "object" ||
    otpPayload === null ||
    !("otp" in otpPayload) ||
    typeof otpPayload.otp !== "string"
  ) {
    throw new Error("The development OTP response had no OTP");
  }

  const signInResponse = await api.post(
    `${API_BASE_URL}/api/auth/sign-in/email-otp`,
    { data: { email, otp: otpPayload.otp } },
  );
  expect(signInResponse.ok(), await signInResponse.text()).toBe(true);
};

const createOrganizationSelectionSession = async ({
  email,
  organizationName,
  organizationSlug,
}: {
  email: string;
  organizationName: string;
  organizationSlug: string;
}) => {
  const requestOptions = {
    extraHTTPHeaders: { origin: new URL(WEB_BASE_URL).origin },
  };
  const setupApi = await playwrightRequest.newContext(requestOptions);
  try {
    await signIn(setupApi, email);
    const createResponse = await setupApi.post(
      `${API_BASE_URL}/api/auth/organization/create`,
      { data: { name: organizationName, slug: organizationSlug } },
    );
    expect(createResponse.ok(), await createResponse.text()).toBe(true);
  } finally {
    await setupApi.dispose();
  }

  const loginApi = await playwrightRequest.newContext(requestOptions);
  try {
    await signIn(loginApi, email);
    return await loginApi.storageState();
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
    organizationName,
    organizationSlug: `northbridge-legal-${testToken}`,
  });
  await page.context().clearCookies();
  await page.context().addCookies(storageState.cookies);

  await page.goto("/auth/organization?redirectTo=%2Fchat", {
    waitUntil: "commit",
  });
  const organization = page.getByRole("button", { name: organizationName });
  await expect(organization).toBeVisible({ timeout: 30_000 });
  await organization.click();

  await expect(page).toHaveURL(/\/chat\/?$/u, { timeout: 30_000 });
  await expect(
    page.getByRole("textbox", { name: /type your question/iu }),
  ).toBeVisible({ timeout: 30_000 });
});
