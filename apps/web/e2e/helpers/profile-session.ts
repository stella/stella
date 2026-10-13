import type { APIRequestContext, Page } from "@playwright/test";
import { request as playwrightRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { E2E_API_ORIGIN } from "./api";
import { signInWithEmailOtp } from "./sign-in";
import { expect } from "./test";

type ObjectValue = Record<string, unknown>;
const isObjectValue = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const objectValue = (value: unknown): ObjectValue => {
  if (!isObjectValue(value)) {
    throw new Error("Expected an object response from the auth API");
  }
  return value;
};

const stringField = (object: ObjectValue, key: string): string => {
  const value = object[key];
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${key} in the auth API response`);
  }
  return value;
};

const deleteTemporaryUser = async (api: APIRequestContext, email: string) => {
  const sendOtp = await api.post(`${E2E_API_ORIGIN}/v1/me/delete/send-otp`);
  expect(sendOtp.ok(), await sendOtp.text()).toBe(true);

  const otpResponse = await api.get(
    `${E2E_API_ORIGIN}/dev-public/last-otp?email=${encodeURIComponent(email)}`,
  );
  expect(otpResponse.ok(), await otpResponse.text()).toBe(true);
  const otp = stringField(objectValue(await otpResponse.json()), "otp");

  const deleted = await api.post(`${E2E_API_ORIGIN}/v1/me/delete/verify`, {
    data: { code: otp },
  });
  expect(deleted.ok(), await deleted.text()).toBe(true);
};

type CreateProfileTestSessionOptions = {
  page: Page;
  label: string;
  webUrl: string;
};

export const createProfileTestSession = async ({
  page,
  label,
  webUrl,
}: CreateProfileTestSessionOptions): Promise<{
  cleanup: () => Promise<void>;
}> => {
  const token = randomUUID().slice(0, 8);
  const email = `${label}-${token}@stella.dev`;
  const slug = `${label}-${token}`.toLowerCase();
  const api = await playwrightRequest.newContext({
    extraHTTPHeaders: { origin: new URL(webUrl).origin },
  });
  let organizationId: string | undefined;
  let accountCreated = false;

  try {
    await signInWithEmailOtp(api, email);
    accountCreated = true;

    const organization = await api.post(
      `${E2E_API_ORIGIN}/api/auth/organization/create`,
      {
        data: {
          name: `Profile test ${token}`,
          slug,
          keepCurrentActiveOrganization: false,
        },
      },
    );
    expect(organization.ok(), await organization.text()).toBe(true);
    organizationId = stringField(objectValue(await organization.json()), "id");

    const storageState = await api.storageState();
    await page.context().clearCookies();
    await page.goto("/auth", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.context().addCookies(storageState.cookies);

    return {
      cleanup: async () => {
        try {
          if (organizationId !== undefined) {
            const deletedOrganization = await api.post(
              `${E2E_API_ORIGIN}/api/auth/organization/delete`,
              { data: { organizationId } },
            );
            expect(
              deletedOrganization.ok(),
              await deletedOrganization.text(),
            ).toBe(true);
          }
          if (accountCreated) {
            await deleteTemporaryUser(api, email);
          }
        } finally {
          await api.dispose();
        }
      },
    };
  } catch (error) {
    try {
      if (organizationId !== undefined) {
        await api.post(`${E2E_API_ORIGIN}/api/auth/organization/delete`, {
          data: { organizationId },
        });
      }
      if (accountCreated) {
        await deleteTemporaryUser(api, email);
      }
    } finally {
      await api.dispose();
    }
    throw error;
  }
};
