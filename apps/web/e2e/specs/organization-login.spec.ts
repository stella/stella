import { request as playwrightRequest } from "@playwright/test";

import { expect, test } from "../helpers/test";

const TEST_USER_EMAIL = "test@stella.dev";
const TEST_ORGANIZATION_NAME = "Harbrook & Partners";
const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";

const authenticateWithoutActiveOrganization = async () => {
  const api = await playwrightRequest.newContext({
    extraHTTPHeaders: { origin: new URL(WEB_BASE_URL).origin },
  });

  try {
    const sendResponse = await api.post(
      `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
      { data: { email: TEST_USER_EMAIL, type: "sign-in" } },
    );
    expect(sendResponse.ok(), await sendResponse.text()).toBe(true);

    const otpResponse = await api.get(
      `${API_BASE_URL}/dev-public/last-otp?email=${encodeURIComponent(TEST_USER_EMAIL)}`,
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
      { data: { email: TEST_USER_EMAIL, otp: otpPayload.otp } },
    );
    expect(signInResponse.ok(), await signInResponse.text()).toBe(true);

    const storageState = await api.storageState();
    return storageState;
  } finally {
    await api.dispose();
  }
};

test("selecting an organization completes login and renders the destination", async ({
  page,
}) => {
  const storageState = await authenticateWithoutActiveOrganization();
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
