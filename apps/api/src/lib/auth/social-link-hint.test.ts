import type { GoogleProfile } from "@better-auth/core/social-providers";
import { betterAuth } from "better-auth";
import type { Verification } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getOAuthState } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { describe, expect, setSystemTime, test } from "bun:test";
import * as v from "valibot";

import { hashSessionToken } from "@/api/lib/auth/session-token";
import { SOCIAL_ACCOUNT_LINKING_OPTIONS } from "@/api/lib/auth/social-identity-policy";
import {
  createSocialLinkHintPlugin,
  socialLinkHintIdentifier,
} from "@/api/lib/auth/social-link-hint";
import { PRIVATE_CACHE_CONTROL } from "@/api/lib/security-headers";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const baseURL = "http://localhost:3001";
const email = "account@example.test";
const oauthResponseSchema = v.object({ url: v.string() });
const generic = { method: null, provider: null };
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");

const createFixture = async ({
  verified = true,
  existing = true,
  localVerified = false,
} = {}) => {
  let providerEmail = email;
  let code = "";
  const auth = betterAuth({
    baseURL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    logger: { disabled: true },
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    account: { accountLinking: SOCIAL_ACCOUNT_LINKING_OPTIONS },
    socialProviders: {
      google: {
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        getUserInfo: async () => ({
          user: {
            name: "Account",
            email: providerEmail,
            emailVerified: verified,
          },
          data: asTestRaw<GoogleProfile>({
            sub: "google-account",
            email: providerEmail,
            email_verified: verified,
          }),
        }),
      },
    },
    plugins: [
      emailOTP({
        sendVerificationOTP: async ({ otp }) => {
          code = otp;
        },
      }),
      {
        id: "fixture-oauth-exchange",
        init: async (context) => ({
          context: {
            socialProviders: context.socialProviders.map((provider) => ({
              ...provider,
              validateAuthorizationCode: async () => ({
                accessToken: "fixture-access-token",
              }),
            })),
          },
        }),
      },
      createSocialLinkHintPlugin(getOAuthState),
    ],
  });
  const context = await auth.$context;
  const hints = async () =>
    await context.adapter.findMany<Verification>({
      model: "verification",
      where: [
        {
          field: "identifier",
          operator: "starts_with",
          value: "social-link-hint:",
        },
      ],
    });
  if (existing) {
    const user = await context.internalAdapter.createUser(
      { email, name: "Account", emailVerified: localVerified },
      { method: "admin" },
    );
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "microsoft",
      accountId: "microsoft-account",
    });
  }
  const start = async () => {
    const response = await auth.api.signInSocial({
      body: {
        provider: "google",
        callbackURL: `${baseURL}/signed-in`,
        errorCallbackURL: `${baseURL}/auth/error`,
      },
      asResponse: true,
    });
    const body = v.parse(oauthResponseSchema, await response.json());
    expect(response.status).toBe(200);
    const state = new URL(body.url).searchParams.get("state");
    expect(state).toBeString();
    return { cookie: cookies(response), state };
  };
  const callback = async ({
    cookie,
    state,
  }: Awaited<ReturnType<typeof start>>) =>
    await auth.handler(
      new Request(
        `${baseURL}/api/auth/callback/google?state=${state}&code=fixture-code`,
        { headers: { cookie } },
      ),
    );
  const consume = async (cookie = "") =>
    await auth.handler(
      new Request(`${baseURL}/api/auth/social-link-hint`, {
        method: "POST",
        headers: { cookie, origin: baseURL },
      }),
    );
  const proveEmail = async () => {
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    expect(code).toMatch(/^\d{6}$/u);
    const response = await auth.api.signInEmailOTP({
      body: { email, otp: code },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    expect(
      (await context.internalAdapter.findUserByEmail(email))?.user
        .emailVerified,
    ).toBe(true);
    return cookies(response);
  };
  const link = async (cookie: string) => {
    const response = await auth.api.linkSocialAccount({
      body: {
        provider: "google",
        callbackURL: `${baseURL}/signed-in`,
        errorCallbackURL: `${baseURL}/auth/error`,
      },
      headers: new Headers({ cookie, origin: baseURL }),
      asResponse: true,
    });
    expect(response.status).toBe(200);
    const body = v.parse(oauthResponseSchema, await response.json());
    const state = new URL(body.url).searchParams.get("state");
    return await callback({ state, cookie: `${cookie}; ${cookies(response)}` });
  };
  return {
    auth,
    context,
    hints,
    start,
    callback,
    consume,
    proveEmail,
    link,
    chooseProviderEmail: (value: string) => {
      providerEmail = value;
    },
  };
};

describe("social callback method hints", () => {
  test("requires a session for an explicit link before email proof", async () => {
    const fixture = await createFixture();
    const response = await fixture.auth.api.linkSocialAccount({
      body: { provider: "google", callbackURL: `${baseURL}/signed-in` },
      headers: new Headers({ origin: baseURL }),
      asResponse: true,
    });
    expect(response.status).toBe(401);
    expect(
      await fixture.context.internalAdapter.findAccountByKey({
        providerId: "google",
        accountId: "google-account",
      }),
    ).toBeNull();
  });
  test("refuses an unverified provider email after email proof", async () => {
    const fixture = await createFixture({ verified: false });
    const response = await fixture.link(await fixture.proveEmail());
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("unable_to_link_account");
    expect(
      await fixture.context.internalAdapter.findAccountByKey({
        providerId: "google",
        accountId: "google-account",
      }),
    ).toBeNull();
    expect((await fixture.hints()).length).toBe(0);
  });
  test.each([email, "other@example.test"])(
    "links after email proof only when the verified provider email matches: %s",
    async (selectedEmail) => {
      const fixture = await createFixture();
      const refused = await fixture.callback(await fixture.start());
      expect(
        new URL(refused.headers.get("location") ?? "").searchParams.get(
          "error",
        ),
      ).toBe("account_not_linked");
      expect(
        await fixture.context.internalAdapter.findAccountByKey({
          providerId: "google",
          accountId: "google-account",
        }),
      ).toBeNull();
      const sessionCookie = await fixture.proveEmail();
      fixture.chooseProviderEmail(selectedEmail);
      const result = await fixture.link(sessionCookie);
      expect(result.status).toBe(302);
      const location = new URL(result.headers.get("location") ?? "");
      const account = await fixture.context.internalAdapter.findAccountByKey({
        providerId: "google",
        accountId: "google-account",
      });
      if (selectedEmail === email) {
        expect(location.pathname).toBe("/signed-in");
        expect(account?.userId).toBe(
          (await fixture.context.internalAdapter.findUserByEmail(email))?.user
            .id,
        );
      } else {
        expect(location.searchParams.get("error")).toBe("email_does_not_match");
        expect(account).toBeNull();
      }
    },
  );
  test.each([false, true])(
    "shows a verified callback's existing method once without linking an account (local verified: %s)",
    async (localVerified) => {
      const fixture = await createFixture({ localVerified });
      const attempt = await fixture.start();
      const response = await fixture.callback(attempt);
      expect(response.status).toBe(302);
      expect(
        new URL(response.headers.get("location") ?? "").searchParams.get(
          "error",
        ),
      ).toBe("account_not_linked");
      expect((await fixture.hints()).length).toBe(1);
      const signedCookie = response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("better-auth.social_link_hint="));
      expect(signedCookie).toBeDefined();
      const cookiePair = signedCookie?.split(";").at(0) ?? "";
      const signedValue = decodeURIComponent(
        cookiePair.slice(cookiePair.indexOf("=") + 1),
      );
      const value = signedValue.slice(0, signedValue.lastIndexOf("."));
      expect((await fixture.hints()).at(0)?.identifier).toBe(
        socialLinkHintIdentifier(value),
      );
      expect((await fixture.hints()).at(0)?.value).toBe("");
      expect(JSON.parse(value)).toMatchObject({
        method: "microsoft",
        provider: "google",
        attempt: hashSessionToken(attempt.state ?? ""),
      });
      expect(
        response.headers
          .getSetCookie()
          .some(
            (cookie) =>
              cookie.includes("HttpOnly") && cookie.includes("Max-Age=600"),
          ),
      ).toBe(true);
      const hintCookie = cookies(response);
      const first = await fixture.consume(hintCookie);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
      expect(await first.json()).toEqual({
        method: "microsoft",
        provider: "google",
      });
      expect(await (await fixture.consume(hintCookie)).json()).toEqual(generic);
      expect(
        await fixture.context.internalAdapter.findAccountByKey({
          providerId: "google",
          accountId: "google-account",
        }),
      ).toBeNull();
    },
  );
  test.each([
    { verified: false, existing: true },
    { verified: true, existing: false },
  ])(
    "returns a generic hint without verified existing identity: %j",
    async (options) => {
      const fixture = await createFixture(options);
      const response = await fixture.callback(await fixture.start());
      expect((await fixture.hints()).length).toBe(0);
      expect(await (await fixture.consume(cookies(response))).json()).toEqual(
        generic,
      );
    },
  );
  test("returns the generic page for absent, altered and expired hints", async () => {
    const clock = new Date("2026-01-01T00:00:00Z");
    setSystemTime(clock);
    try {
      const fixture = await createFixture();
      const response = await fixture.callback(await fixture.start());
      const cookie = cookies(response);
      expect((await fixture.hints()).length).toBe(1);
      expect(await (await fixture.consume()).json()).toEqual(generic);
      const altered = cookie.replace("microsoft", "google");
      expect(altered).not.toBe(cookie);
      expect(await (await fixture.consume(altered)).json()).toEqual(generic);
      setSystemTime(new Date(clock.getTime() + 10 * 60 * 1000));
      expect(await (await fixture.consume(cookie)).json()).toEqual(generic);
    } finally {
      setSystemTime();
    }
  });
  test("only one concurrent reader can consume the same hint", async () => {
    const fixture = await createFixture();
    const response = await fixture.callback(await fixture.start());
    expect((await fixture.hints()).length).toBe(1);
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const consumed = await fixture.consume(cookies(response));
        expect(consumed.status).toBe(200);
        return await consumed.json();
      }),
    );
    expect(
      results.filter(
        (result) =>
          JSON.stringify(result) ===
          JSON.stringify({ method: "microsoft", provider: "google" }),
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => JSON.stringify(result) === JSON.stringify(generic),
      ),
    ).toHaveLength(7);
  });
  test("requires the state cookie for its matching callback attempt", async () => {
    const fixture = await createFixture();
    const first = await fixture.start();
    const second = await fixture.start();
    expect(first.state).not.toBe(second.state);
    const response = await fixture.callback({
      state: first.state,
      cookie: second.cookie,
    });
    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("state_mismatch");
    expect((await fixture.hints()).length).toBe(0);
    expect(await (await fixture.consume(cookies(response))).json()).toEqual(
      generic,
    );
  });
});
