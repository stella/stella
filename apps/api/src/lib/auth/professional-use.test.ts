import type { GoogleProfile } from "@better-auth/core/social-providers";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getOAuthState } from "better-auth/api";
import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";

import { AGENT_IDENTITY_CREATE_USER_PATH } from "@/api/lib/auth/agent-auth-user";
import {
  readCreationAcceptance,
  requireUserCreationOrigin,
} from "@/api/lib/auth/professional-use";
import type { CreationAcceptance } from "@/api/lib/auth/professional-use";
import { REVIEW_ACCOUNT_CREATE_USER_PATH } from "@/api/lib/auth/review-account-plugin";

const STALE_VERSION = "2000-01";

describe("account creation origin", () => {
  test.each([
    ["/sign-in/email-otp", "email_otp_registration"],
    ["/callback/google", "social_registration"],
    ["/callback/microsoft", "social_registration"],
    ["/callback/:id", "social_registration"],
    ["/sign-up/email", "bootstrap_registration"],
    ["/sign-in/social", "identity_token_sign_in"],
    [AGENT_IDENTITY_CREATE_USER_PATH, "agent_provisioning"],
    [REVIEW_ACCOUNT_CREATE_USER_PATH, "operator_command"],
  ] as const)("an account created through %s has origin %s", (path, origin) => {
    expect(requireUserCreationOrigin(path)).toBe(origin);
  });

  // A creation path nobody classified must not record, or skip, an
  // acceptance by default: the user hook refuses the creation.
  test.each([
    ["/admin/create-user"],
    ["/sign-in/anonymous"],
    ["/callback"],
    ["virtual:"],
    [undefined],
  ] as const)("refuses an account created through %p", (path) => {
    expect(() => requireUserCreationOrigin(path)).toThrow(
      "has no professional-use origin",
    );
  });
});

describe("acceptance at creation", () => {
  const bodyCases = [
    [
      "the current version",
      {
        [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
          PROFESSIONAL_USE_STATEMENT_VERSION,
      },
      {
        type: "accepted",
        statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
      },
    ],
    [
      "a stale version",
      { [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]: STALE_VERSION },
      { type: "required", reason: "displayed_version_stale" },
    ],
    [
      "no version",
      {},
      { type: "required", reason: "displayed_version_absent" },
    ],
    [
      "a version that is not a string",
      { [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]: 202_610 },
      { type: "required", reason: "displayed_version_absent" },
    ],
  ] as const satisfies readonly (readonly [
    string,
    Record<string, unknown>,
    CreationAcceptance,
  ])[];

  for (const path of ["/sign-in/email-otp", "/sign-up/email"]) {
    test.each(bodyCases)(
      `a registration through ${path} naming %s`,
      async (_name, body, expected) => {
        expect(
          await readCreationAcceptance(
            { path, body: { ...body } },
            getOAuthState,
          ),
        ).toEqual(expected);
      },
    );
  }

  test.each([
    ["/sign-in/social"],
    [AGENT_IDENTITY_CREATE_USER_PATH],
    [REVIEW_ACCOUNT_CREATE_USER_PATH],
  ])(
    "an account created through %s is never accepted, whatever it names",
    async (path) => {
      expect(
        await readCreationAcceptance(
          {
            path,
            body: {
              [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
                PROFESSIONAL_USE_STATEMENT_VERSION,
            },
          },
          getOAuthState,
        ),
      ).toEqual({ type: "required", reason: "statement_not_shown" });
    },
  );

  const BASE_URL = "http://localhost:3001";

  // Drives Better Auth's own social sign-in and callback: the version the
  // sign-in names in `additionalData` must reach the account-creating
  // callback through the OAuth state.
  const registerThroughSocialCallback = async (
    additionalData: Record<string, unknown> | undefined,
  ): Promise<CreationAcceptance[]> => {
    const decisions: CreationAcceptance[] = [];
    const auth = betterAuth({
      baseURL: BASE_URL,
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      socialProviders: {
        google: {
          clientId: "test-client",
          clientSecret: "test-secret",
          getUserInfo: async () =>
            await Promise.resolve({
              user: {
                name: "Account",
                email: "social-registration@example.test",
                emailVerified: true,
              },
              data: {
                aud: "test-client",
                azp: "test-client",
                email: "social-registration@example.test",
                email_verified: true,
                exp: Math.floor(Date.now() / 1000) + 3600,
                family_name: "Fixture",
                given_name: "Account",
                iat: Math.floor(Date.now() / 1000),
                iss: "https://accounts.google.com",
                name: "Account",
                picture: "https://example.test/avatar.png",
                sub: "provider-account",
              } satisfies GoogleProfile,
            }),
        },
      },
      databaseHooks: {
        user: {
          create: {
            after: async (_user, context) => {
              decisions.push(
                await readCreationAcceptance(context, getOAuthState),
              );
            },
          },
        },
      },
    });
    const started = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/",
          ...(additionalData === undefined ? {} : { additionalData }),
        }),
      }),
    );
    expect(started.status).toBe(200);
    const { url } = v.parse(
      v.object({ url: v.string() }),
      await started.json(),
    );
    const state = new URL(url).searchParams.get("state");
    expect(state).not.toBeNull();
    const cookie = started.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0) ?? "")
      .join("; ");

    // The provider's token endpoint is the one network call of the callback.
    const fetchToken = Object.assign(
      async () =>
        await Promise.resolve(
          Response.json({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        ),
      { preconnect: globalThis.fetch.preconnect },
    );
    const tokenExchange = spyOn(globalThis, "fetch").mockImplementation(
      fetchToken,
    );
    try {
      const callback = await auth.handler(
        new Request(
          `${BASE_URL}/api/auth/callback/google?code=code&state=${encodeURIComponent(state ?? "")}`,
          { headers: { cookie } },
        ),
      );
      expect(callback.status).toBe(302);
    } finally {
      tokenExchange.mockRestore();
    }
    return decisions;
  };

  test("the social callback carries the version the sign-in named", async () => {
    expect(
      await registerThroughSocialCallback({
        [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
          PROFESSIONAL_USE_STATEMENT_VERSION,
      }),
    ).toEqual([
      {
        type: "accepted",
        statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
      },
    ]);
    expect(
      await registerThroughSocialCallback({
        [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]: STALE_VERSION,
      }),
    ).toEqual([{ type: "required", reason: "displayed_version_stale" }]);
    expect(await registerThroughSocialCallback(undefined)).toEqual([
      { type: "required", reason: "displayed_version_absent" },
    ]);
  });
});
