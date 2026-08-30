import {
  type APIRequestContext,
  request as playwrightRequest,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

import { expect, test } from "../helpers/test";

const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const TEST_ORGANIZATION_NAME = "Harbrook & Partners";

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
  ownerApi,
}: {
  email: string;
  ownerApi: APIRequestContext;
}) => {
  const requestOptions = {
    extraHTTPHeaders: { origin: new URL(WEB_BASE_URL).origin },
  };
  const inviteResponse = await ownerApi.post(
    `${API_BASE_URL}/api/auth/organization/invite-member`,
    {
      data: { email, role: "member" },
      headers: requestOptions.extraHTTPHeaders,
    },
  );
  const invitation: unknown = await inviteResponse.json();
  expect(inviteResponse.ok(), JSON.stringify(invitation)).toBe(true);
  if (
    typeof invitation !== "object" ||
    invitation === null ||
    !("id" in invitation) ||
    typeof invitation.id !== "string"
  ) {
    throw new Error("The organization invitation response had no id");
  }

  const loginApi = await playwrightRequest.newContext(requestOptions);
  try {
    await signIn(loginApi, email);
    // Accepting the invitation activates its organization and refreshes the
    // cached session cookie. Preserve the signed pre-accept snapshot so the
    // route sees a real membership with no active organization selected.
    const storageStateWithoutActiveOrganization = await loginApi.storageState();
    const acceptResponse = await loginApi.post(
      `${API_BASE_URL}/api/auth/organization/accept-invitation`,
      { data: { invitationId: invitation.id } },
    );
    expect(acceptResponse.ok(), await acceptResponse.text()).toBe(true);
    return storageStateWithoutActiveOrganization;
  } finally {
    await loginApi.dispose();
  }
};

test("selecting an organization completes login and renders the destination", async ({
  page,
  request,
}) => {
  const testToken = randomUUID().slice(0, 8);
  const storageState = await createOrganizationSelectionSession({
    email: `organization-login-${testToken}@stella.dev`,
    ownerApi: request,
  });
  await page.context().clearCookies();
  await page.context().addCookies(storageState.cookies);

  await page.goto("/auth/organization?redirectTo=%2Fchat", {
    waitUntil: "commit",
  });
  const organization = page.getByRole("button", {
    name: TEST_ORGANIZATION_NAME,
  });
  await expect(organization).toBeVisible({ timeout: 30_000 });
  await organization.click();

  await expect(page).toHaveURL(/\/chat\/?$/u, { timeout: 30_000 });
  await expect(
    page.getByRole("textbox", { name: /type your question/iu }),
  ).toBeVisible({ timeout: 30_000 });
});
