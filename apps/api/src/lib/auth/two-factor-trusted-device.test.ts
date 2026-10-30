import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withoutTrustedDeviceBypass } from "@/api/lib/auth/two-factor-trusted-device";

const email = "account@example.test";
const password = "correct horse battery staple";
const secret = "test-secret-that-is-long-enough-for-better-auth";

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/**
 * Two instances over one store, as during a rolling deployment: an older one
 * that still issues trusted-device grants and the current one.
 */
const createRollingDeployment = async () => {
  const database = memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
  });
  const options = {
    baseURL: "http://localhost:3001",
    secret,
    database,
    emailAndPassword: { enabled: true },
  };
  const older = betterAuth({
    ...options,
    plugins: [
      twoFactor({ skipVerificationOnEnable: true, trustDeviceMaxAge: 3600 }),
    ],
  });
  const current = betterAuth({
    ...options,
    plugins: [
      withoutTrustedDeviceBypass(
        twoFactor({ skipVerificationOnEnable: true, trustDeviceMaxAge: 0 }),
      ),
    ],
  });
  await older.api.signUpEmail({ body: { email, password, name: "Account" } });
  const signedIn = await older.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const enabled = await older.api.enableTwoFactor({
    body: { password },
    headers: new Headers({ cookie: cookiesOf(signedIn) }),
  });
  if (enabled.method !== "totp") {
    panic("Two-factor enrolment did not return backup codes");
  }
  const { backupCodes } = enabled;
  const signIn = async (
    auth: typeof older | typeof current,
    cookie: string,
  ): Promise<Response> =>
    await auth.handler(
      new Request("http://localhost:3001/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ email, password }),
      }),
    );
  // The older instance completes a second factor and trusts the browser.
  const pending = await signIn(older, "");
  const trusted = await older.handler(
    new Request(
      "http://localhost:3001/api/auth/two-factor/verify-backup-code",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookiesOf(pending),
        },
        body: JSON.stringify({
          code: backupCodes.at(0) ?? panic("Backup code fixture missing"),
          trustDevice: true,
        }),
      },
    ),
  );
  const trustCookie =
    trusted.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0] ?? "")
      .find((cookie) => cookie.includes("trust_device")) ??
    panic("The older instance did not trust the device");
  return { older, current, signIn, trustCookie };
};

describe("trusted-device grants", () => {
  test("a grant an older instance issued still skips the factor there", async () => {
    const { older, signIn, trustCookie } = await createRollingDeployment();
    const response = await signIn(older, trustCookie);
    expect(await response.json()).not.toMatchObject({
      twoFactorRedirect: true,
    });
  });

  test("the current instance asks for the second factor despite an unexpired grant", async () => {
    const { current, signIn, trustCookie } = await createRollingDeployment();
    const response = await signIn(current, trustCookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    expect(
      response.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.includes("session_token=") && !cookie.includes("Max-Age=0"),
        ),
    ).toBe(false);
  });
});
