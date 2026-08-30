import { request as playwrightRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { expect, test } from "../helpers/test";

const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";

const authenticateWithoutActiveOrganization = async (email: string) => {
  const api = await playwrightRequest.newContext({
    extraHTTPHeaders: { origin: new URL(WEB_BASE_URL).origin },
  });

  try {
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

    const storageState = await api.storageState();
    return storageState;
  } finally {
    await api.dispose();
  }
};

test("creating an organization completes login and renders the destination", async ({
  page,
}) => {
  const testToken = randomUUID().slice(0, 8);
  const organizationName = `Northbridge Legal ${testToken}`;
  const storageState = await authenticateWithoutActiveOrganization(
    `organization-login-${testToken}@stella.dev`,
  );
  await page.context().clearCookies();
  await page.context().addCookies(storageState.cookies);

  await page.goto("/auth/organization?redirectTo=%2Fchat", {
    waitUntil: "commit",
  });
  const organizationNameInput = page.getByLabel("Organization name");
  await expect(organizationNameInput).toBeVisible({ timeout: 30_000 });
  await organizationNameInput.fill(organizationName);
  await page.getByRole("button", { name: "Create organization" }).click();

  await expect(page).toHaveURL(/\/chat\/?$/u, { timeout: 30_000 });
  await expect(
    page.getByRole("textbox", { name: /type your question/iu }),
  ).toBeVisible({ timeout: 30_000 });
});
