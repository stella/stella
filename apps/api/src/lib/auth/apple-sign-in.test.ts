import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { panic } from "better-result";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { generateKeyPairSync } from "node:crypto";
import * as v from "valibot";

import {
  APPLE_FORM_POST,
  withAppleFormPostOrigin,
} from "@/api/lib/auth/apple-callback";
import {
  APPLE_CLIENT_SECRET_AUDIENCE,
  APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
  createAppleClientSecretSource,
  createAppleProviderOptions,
  resolveAppleSignIn,
} from "@/api/lib/auth/apple-sign-in";
import type { AppleSignInSettings } from "@/api/lib/auth/apple-sign-in";
import { AUTH_API_PATH } from "@/api/lib/auth/auth-paths";
import {
  createSocialIdentityValidation,
  SOCIAL_ACCOUNT_LINKING_OPTIONS,
} from "@/api/lib/auth/social-identity-policy";

// A throwaway key per run: no real Apple key is ever read.
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const appleEnv = {
  APPLE_AUTH_CLIENT_ID: "app.example.web",
  APPLE_AUTH_TEAM_ID: "TEAM123456",
  APPLE_AUTH_KEY_ID: "KEY1234567",
  APPLE_AUTH_PRIVATE_KEY: privateKeyPem,
};
const SIX_MONTHS_SECONDS = 15_777_000;

const enabledSettings = (): AppleSignInSettings => {
  const resolved = resolveAppleSignIn(appleEnv).unwrap();
  return resolved.type === "enabled"
    ? resolved
    : panic("The fixture configuration must enable Apple");
};

describe("Sign in with Apple configuration", () => {
  test("is disabled when no Apple setting is present", () => {
    expect(resolveAppleSignIn({}).unwrap()).toEqual({ type: "disabled" });
  });

  test.each(Object.keys(appleEnv))(
    "refuses a configuration missing %s",
    (missing) => {
      const resolved = resolveAppleSignIn({
        ...appleEnv,
        [missing]: undefined,
      });
      expect(resolved.isErr()).toBe(true);
      expect(resolved.isErr() && resolved.error.message).toContain(
        "must be configured together",
      );
    },
  );

  test.each([
    { APPLE_AUTH_TEAM_ID: "team" },
    { APPLE_AUTH_KEY_ID: "KEY12345678" },
  ])("refuses a malformed Apple identifier: %j", (override) => {
    const resolved = resolveAppleSignIn({ ...appleEnv, ...override });
    expect(resolved.isErr() && resolved.error.message).toContain(
      "ten-character identifiers",
    );
  });

  test.each([
    [
      "not PEM",
      "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----",
    ],
    [
      "a P-384 key",
      generateKeyPairSync("ec", { namedCurve: "secp384r1" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    ],
    [
      "an RSA key",
      generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    ],
  ])("refuses a private key that is %s", (_label, pem) => {
    const resolved = resolveAppleSignIn({
      ...appleEnv,
      APPLE_AUTH_PRIVATE_KEY: pem,
    });
    expect(resolved.isErr() && resolved.error.message).toContain(
      "APPLE_AUTH_PRIVATE_KEY",
    );
  });

  test("reads a key stored with escaped newlines", () => {
    const escaped = privateKeyPem.trimEnd().replaceAll("\n", "\\n");
    expect(escaped).not.toContain("\n");
    expect(
      resolveAppleSignIn({
        ...appleEnv,
        APPLE_AUTH_PRIVATE_KEY: escaped,
      }).unwrap().type,
    ).toBe("enabled");
  });
});

describe("Apple client secret", () => {
  test("is an ES256 JWT Apple can verify with the key's public half", async () => {
    const issuedAt = 1_800_000_000;
    const secret = createAppleClientSecretSource(
      enabledSettings(),
      () => issuedAt,
    )();
    expect(decodeProtectedHeader(secret)).toEqual({
      alg: "ES256",
      kid: appleEnv.APPLE_AUTH_KEY_ID,
    });
    const { payload } = await jwtVerify(secret, publicKey, {
      algorithms: ["ES256"],
      audience: APPLE_CLIENT_SECRET_AUDIENCE,
      issuer: appleEnv.APPLE_AUTH_TEAM_ID,
      subject: appleEnv.APPLE_AUTH_CLIENT_ID,
      currentDate: new Date(issuedAt * 1000),
    });
    expect(payload.iat).toBe(issuedAt);
    expect(payload.exp).toBe(issuedAt + APPLE_CLIENT_SECRET_LIFETIME_SECONDS);
    expect(APPLE_CLIENT_SECRET_LIFETIME_SECONDS).toBeLessThanOrEqual(
      SIX_MONTHS_SECONDS,
    );
  });

  test("is reused while fresh and replaced before it expires", async () => {
    let now = 1_800_000_000;
    const source = createAppleClientSecretSource(enabledSettings(), () => now);
    const first = source();
    now += 60;
    expect(source()).toBe(first);

    // Every secret handed out is still valid for its whole use.
    for (
      let elapsed = 0;
      elapsed <= APPLE_CLIENT_SECRET_LIFETIME_SECONDS * 3;
      elapsed += 60
    ) {
      now = 1_800_000_000 + elapsed;
      const { payload } = await jwtVerify(source(), publicKey, {
        currentDate: new Date(now * 1000),
      });
      expect((payload.exp ?? 0) - now).toBeGreaterThan(5 * 60);
    }
    expect(source()).not.toBe(first);
  });

  test("provider options read the secret anew on every access", () => {
    let calls = 0;
    const options = createAppleProviderOptions(enabledSettings(), () => {
      calls += 1;
      return `secret-${calls}`;
    });
    expect(options.clientSecret).toBe("secret-1");
    expect(options.clientSecret).toBe("secret-2");
    expect(options.disableIdTokenSignIn).toBe(true);
  });
});

const baseURL = "https://my.example.test";
const relayEmail = "q7x2k9@privaterelay.appleid.com";
const oauthResponseSchema = v.object({ url: v.string() });
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");
const base64UrlJson = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

type AppleIdentity = { email: string; emailVerified: "true" | "false" };

const createAppleFixture = async () => {
  let now = 1_800_000_000;
  let identity: AppleIdentity = { email: relayEmail, emailVerified: "true" };
  const clientSecrets: string[] = [];
  const settings = enabledSettings();
  // Apple's token endpoint: the code exchange is the only outbound call.
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        expect(url).toBe("https://appleid.apple.com/auth/token");
        const body = new URLSearchParams(String(init?.body));
        clientSecrets.push(body.get("client_secret") ?? "");
        return Response.json({
          access_token: "apple-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: [
            base64UrlJson({ alg: "RS256", kid: "apple" }),
            base64UrlJson({
              iss: "https://appleid.apple.com",
              aud: settings.clientId,
              sub: "001234.apple-subject.0001",
              email: identity.email,
              email_verified: identity.emailVerified,
              is_private_email: "true",
            }),
            "signature",
          ].join("."),
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const auth = betterAuth({
    baseURL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    logger: { disabled: true },
    trustedOrigins: (request) => withAppleFormPostOrigin(request, [baseURL]),
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    user: {
      validateUserInfo: createSocialIdentityValidation({
        tenantId: undefined,
        requireMicrosoftVerifiedEmailClaim: true,
        warn: () => {},
      }),
    },
    account: { accountLinking: SOCIAL_ACCOUNT_LINKING_OPTIONS },
    socialProviders: {
      apple: createAppleProviderOptions(
        settings,
        createAppleClientSecretSource(settings, () => now),
      ),
    },
  });
  const context = await auth.$context;

  const start = async () => {
    const response = await auth.api.signInSocial({
      body: {
        provider: "apple",
        callbackURL: `${baseURL}/auth/organization`,
        errorCallbackURL: `${baseURL}/auth/error`,
      },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    const authorization = new URL(
      v.parse(oauthResponseSchema, await response.json()).url,
    );
    expect(authorization.origin).toBe(APPLE_FORM_POST.origin);
    expect(authorization.searchParams.get("response_mode")).toBe("form_post");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${baseURL}${APPLE_FORM_POST.pathname}`,
    );
    return {
      cookie: cookies(response),
      state: authorization.searchParams.get("state") ?? "",
    };
  };

  /**
   * Apple's form post. A cross-site POST carries no `SameSite=Lax` cookie,
   * but it does carry `SameSite=None` ones, such as a load balancer's.
   */
  const formPost = async ({
    state,
    origin = APPLE_FORM_POST.origin,
    pathname = APPLE_FORM_POST.pathname,
  }: {
    state: string;
    origin?: string;
    pathname?: string;
  }) =>
    await auth.handler(
      new Request(`${baseURL}${pathname}`, {
        method: "POST",
        headers: {
          origin,
          cookie: "AWSALBCORS=balancer",
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
        },
        body: new URLSearchParams({
          state,
          code: "apple-code",
          user: JSON.stringify({
            name: { firstName: "Ada", lastName: "Lovelace" },
            email: identity.email,
          }),
        }),
      }),
    );

  /** The top-level GET the form post redirects to, with the Lax cookies. */
  const follow = async (location: string, cookie: string) =>
    await auth.handler(new Request(location, { headers: { cookie } }));

  const signIn = async () => {
    const started = await start();
    const posted = await formPost({ state: started.state });
    expect(posted.status).toBe(302);
    return await follow(posted.headers.get("location") ?? "", started.cookie);
  };

  return {
    auth,
    context,
    clientSecrets,
    fetchSpy,
    start,
    formPost,
    follow,
    signIn,
    advanceSeconds: (seconds: number) => {
      now += seconds;
    },
    useIdentity: (next: AppleIdentity) => {
      identity = next;
    },
  };
};

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

const fixture = async () => {
  const created = await createAppleFixture();
  restoreFetch = () => created.fetchSpy.mockRestore();
  return created;
};

describe("Sign in with Apple callback", () => {
  test("turns Apple's form post into a same-site GET on the same callback", async () => {
    const apple = await fixture();
    const { state } = await apple.start();
    const response = await apple.formPost({ state });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      `${baseURL}${AUTH_API_PATH}/callback/apple`,
    );
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code")).toBe("apple-code");
    // The POST itself signs nobody in.
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(apple.fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    { origin: "https://attacker.example", pathname: APPLE_FORM_POST.pathname },
    {
      origin: APPLE_FORM_POST.origin,
      pathname: `${AUTH_API_PATH}/callback/google`,
    },
  ])(
    "keeps refusing other cross-site posts that carry cookies: %j",
    async (request) => {
      const apple = await fixture();
      const { state } = await apple.start();
      const response = await apple.formPost({ state, ...request });
      expect(response.status).toBe(403);
    },
  );

  test("signs in with a private relay address, keeping the first-time name", async () => {
    const apple = await fixture();
    const response = await apple.signIn();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${baseURL}/auth/organization`,
    );
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.includes("session_token=")),
    ).toBe(true);
    const created = await apple.context.internalAdapter.findUserByEmail(
      relayEmail,
      { includeAccounts: true },
    );
    expect(created?.user).toMatchObject({
      email: relayEmail,
      emailVerified: true,
      name: "Ada Lovelace",
    });
    expect(created?.accounts.map((account) => account.providerId)).toEqual([
      "apple",
    ]);
  });

  test("signs the code exchange with a client secret it renews over time", async () => {
    const apple = await fixture();
    await apple.signIn();
    apple.advanceSeconds(APPLE_CLIENT_SECRET_LIFETIME_SECONDS);
    await apple.signIn();

    expect(apple.clientSecrets).toHaveLength(2);
    const [first, second] = apple.clientSecrets;
    expect(first).not.toBe(second);
    for (const secret of apple.clientSecrets) {
      const { payload } = await jwtVerify(secret, publicKey, {
        audience: APPLE_CLIENT_SECRET_AUDIENCE,
        issuer: appleEnv.APPLE_AUTH_TEAM_ID,
        subject: appleEnv.APPLE_AUTH_CLIENT_ID,
        currentDate: new Date((decodeJwt(secret).iat ?? 0) * 1000),
      });
      expect(payload.exp).toBeDefined();
    }
  });

  test("refuses an Apple identity whose email Apple did not verify", async () => {
    const apple = await fixture();
    apple.useIdentity({
      email: "person@school.example",
      emailVerified: "false",
    });
    const response = await apple.signIn();

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/auth/error");
    expect(location.searchParams.get("error")).toBe("identity_not_allowed");
    expect(
      await apple.context.internalAdapter.findUserByEmail(
        "person@school.example",
      ),
    ).toBeNull();
  });

  test("never joins an existing account with the same email", async () => {
    const apple = await fixture();
    const email = "counsel@firm.example";
    const existing = await apple.context.internalAdapter.createUser(
      { email, name: "Counsel", emailVerified: true },
      { method: "admin" },
    );
    await apple.context.internalAdapter.linkAccount({
      userId: existing.id,
      providerId: "google",
      accountId: "google-account",
    });
    apple.useIdentity({ email, emailVerified: "true" });
    const response = await apple.signIn();

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("account_not_linked");
    const accounts = await apple.context.internalAdapter.findAccounts(
      existing.id,
    );
    expect(accounts.map((account) => account.providerId)).toEqual(["google"]);
  });
});
