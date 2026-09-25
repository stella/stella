import { expect, type APIRequestContext } from "@playwright/test";

import { E2E_API_ORIGIN } from "./api";

/**
 * Signs `email` in on `api` through the email OTP flow, reading the code from
 * the development OTP endpoint. The context keeps the session cookie.
 */
export const signInWithEmailOtp = async (
  api: APIRequestContext,
  email: string,
): Promise<void> => {
  const sendResponse = await api.post(
    `${E2E_API_ORIGIN}/api/auth/email-otp/send-verification-otp`,
    { data: { email, type: "sign-in" } },
  );
  expect(sendResponse.ok(), await sendResponse.text()).toBe(true);

  const otpResponse = await api.get(
    `${E2E_API_ORIGIN}/dev-public/last-otp?email=${encodeURIComponent(email)}`,
  );
  expect(otpResponse.ok(), await otpResponse.text()).toBe(true);
  const otpPayload: unknown = await otpResponse.json();
  if (
    typeof otpPayload !== "object" ||
    otpPayload === null ||
    !("otp" in otpPayload) ||
    typeof otpPayload.otp !== "string"
  ) {
    throw new Error("The development OTP response had no OTP");
  }

  const signInResponse = await api.post(
    `${E2E_API_ORIGIN}/api/auth/sign-in/email-otp`,
    { data: { email, otp: otpPayload.otp } },
  );
  expect(signInResponse.ok(), await signInResponse.text()).toBe(true);
};
