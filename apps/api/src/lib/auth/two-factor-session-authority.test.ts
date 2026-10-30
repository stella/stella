import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { symmetricEncrypt } from "better-auth/crypto";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  getAuth,
  resolveAuthoritativeSessionForSensitiveAuthPath,
  SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
  TWO_FACTOR_SESSION_PATHS,
} from "@/api/lib/auth";

const AUTH_BASE_URL = "http://localhost:3001";
const TOTP_SECRET = "two-factor-session-authority-0001";
const BACKUP_CODE = "AAAAA-11111";

type Row = Record<string, unknown>;

const registeredTwoFactorPlugin = (): BetterAuthPlugin =>
  getAuth().options.plugins.find((plugin) => plugin.id === "two-factor") ??
  panic("The two-factor plugin is not registered");

/**
 * Paths of every endpoint the registered two-factor plugin declares. A
 * server-only endpoint is over-approximated as served: classifying it too is
 * harmless, and missing a served one is not.
 */
const registeredTwoFactorHttpPaths = () =>
  Object.values(registeredTwoFactorPlugin().endpoints ?? {})
    .flatMap((endpoint) =>
      typeof endpoint.path === "string" ? [endpoint.path] : [],
    )
    .toSorted();

const responseCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map(
      (cookie) => cookie.split(";").at(0) ?? panic("Missing response cookie"),
    );

const mergeCookies = (current: string, response: Response) => {
  const jar = new Map(
    current
      .split("; ")
      .filter((pair) => pair !== "")
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair] as const),
  );
  for (const pair of responseCookies(response)) {
    jar.set(pair.slice(0, pair.indexOf("=")), pair);
  }
  return [...jar.values()].filter((pair) => !pair.endsWith("=")).join("; ");
};

const createFixture = async ({
  verified,
  passwordless = true,
}: {
  verified: boolean;
  passwordless?: boolean;
}) => {
  const database: Record<string, Row[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
  };
  const auth = betterAuth({
    baseURL: AUTH_BASE_URL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
      },
    },
    plugins: [registeredTwoFactorPlugin()],
    hooks: {
      // The same session step Stella's global before hook runs.
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.path) {
          return undefined;
        }
        const authoritative =
          await resolveAuthoritativeSessionForSensitiveAuthPath({
            ctx,
            resolveSession: async ({ path }) =>
              await getAuthoritativeSessionFromCtx({ ...ctx, path }),
          });
        if (Result.isError(authoritative)) {
          throw authoritative.error;
        }
        return authoritative.value;
      }),
    },
  });
  const context = await auth.$context;
  const request = async (
    path: string,
    { cookie, body }: { cookie: string; body?: object },
  ) =>
    await auth.handler(
      new Request(`${AUTH_BASE_URL}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie,
          origin: AUTH_BASE_URL,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const signedUp = await request("/sign-up/email", {
    cookie: "",
    body: {
      email: "holder@example.test",
      name: "Holder",
      password: "A secure password 123!",
    },
  });
  expect(signedUp.status).toBe(200);
  const account = database["user"]?.at(0) ?? panic("User missing");
  const userId = String(account["id"]);
  account["twoFactorEnabled"] = verified;
  if (passwordless) {
    // Stella accounts sign in by email code and hold no password.
    database["account"] = [];
  }
  database["twoFactor"]?.push({
    id: "two-factor-row",
    userId,
    secret: await symmetricEncrypt({
      key: context.secretConfig,
      data: TOTP_SECRET,
    }),
    backupCodes: await symmetricEncrypt({
      key: context.secretConfig,
      data: JSON.stringify([BACKUP_CODE]),
    }),
    verified,
  });
  // Re-read the session so the device's signed cache carries the current user.
  let cookie = mergeCookies("", signedUp);
  const refreshed = await request("/get-session?disableCookieCache=true", {
    cookie,
  });
  expect(refreshed.status).toBe(200);
  cookie = mergeCookies(cookie, refreshed);
  // Codes come from the registered plugin's typed server API, so they use the
  // same TOTP settings the endpoints verify against.
  const totpCode = async () => {
    const generated = await getAuth().api.generateTOTP({
      body: { secret: TOTP_SECRET },
    });
    return generated.code;
  };
  const snapshot = () =>
    structuredClone({
      user: database["user"],
      session: database["session"]?.map((row) => row["id"]),
      twoFactor: database["twoFactor"],
    });
  return {
    database,
    cookie,
    request,
    totpCode,
    snapshot,
    revokeAll: () => {
      database["session"] = [];
    },
  };
};

/**
 * What each two-factor endpoint receives from a device that holds a valid
 * code, and the refusal a session absent from storage gets. A new two-factor
 * endpoint fails the registry test below until it is listed here, so the
 * revocation test covers it.
 */
const TWO_FACTOR_REQUESTS: Record<
  string,
  {
    body: (fixture: { totpCode: () => Promise<string> }) => Promise<object>;
    refusal: 400 | 401;
  }
> = {
  "/two-factor/disable": { body: async () => ({}), refusal: 401 },
  "/two-factor/enable": { body: async () => ({}), refusal: 401 },
  "/two-factor/generate-backup-codes": { body: async () => ({}), refusal: 401 },
  "/two-factor/get-totp-uri": { body: async () => ({}), refusal: 401 },
  // Stella configures no second-factor message transport.
  "/two-factor/send-otp": { body: async () => ({}), refusal: 400 },
  "/two-factor/verify-backup-code": {
    body: async () => ({ code: BACKUP_CODE }),
    refusal: 401,
  },
  "/two-factor/verify-otp": {
    body: async () => ({ code: "123456" }),
    refusal: 401,
  },
  "/two-factor/verify-totp": {
    body: async ({ totpCode }) => ({ code: await totpCode() }),
    refusal: 401,
  },
};

describe("two-factor endpoints read the session from storage", () => {
  test("every registered two-factor HTTP endpoint is classified and covered", () => {
    const registered = registeredTwoFactorHttpPaths();
    expect(registered).toEqual(
      Object.keys(TWO_FACTOR_SESSION_PATHS).toSorted(),
    );
    expect(registered).toEqual(Object.keys(TWO_FACTOR_REQUESTS).toSorted());
  });

  for (const verified of [true, false]) {
    test.each(Object.keys(TWO_FACTOR_REQUESTS))(
      `a revoked session inside its cookie-cache window is refused by %s (enrollment verified: ${verified})`,
      async (path) => {
        const fixture = await createFixture({ verified });
        fixture.revokeAll();
        const before = fixture.snapshot();
        const { body: requestBody, refusal } =
          TWO_FACTOR_REQUESTS[path] ?? panic("Request missing");
        const body = await requestBody(fixture);

        const response = await fixture.request(path, {
          cookie: fixture.cookie,
          body,
        });
        const payload: unknown = await response.json();

        expect({ path, status: response.status }).toEqual({
          path,
          status: refusal,
        });
        expect(payload).not.toHaveProperty("totpURI");
        expect(payload).not.toHaveProperty("backupCodes");
        expect(payload).not.toHaveProperty("token");
        expect(fixture.snapshot()).toEqual(before);
      },
    );
  }

  test("a live session still completes TOTP enrollment", async () => {
    const fixture = await createFixture({ verified: false });

    const response = await fixture.request("/two-factor/verify-totp", {
      cookie: fixture.cookie,
      body: { code: await fixture.totpCode() },
    });

    expect(response.status).toBe(200);
    expect(fixture.database["twoFactor"]?.at(0)?.["verified"]).toBe(true);
    expect(fixture.database["user"]?.at(0)?.["twoFactorEnabled"]).toBe(true);
  });

  test("a sign-in challenge still completes without a session", async () => {
    const fixture = await createFixture({
      verified: true,
      passwordless: false,
    });
    const challenged = await fixture.request("/sign-in/email", {
      cookie: "",
      body: {
        email: "holder@example.test",
        password: "A secure password 123!",
      },
    });
    expect(challenged.status).toBe(200);
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    const sessionsBefore = fixture.database["session"]?.length ?? 0;

    const response = await fixture.request("/two-factor/verify-totp", {
      cookie: mergeCookies("", challenged),
      body: { code: await fixture.totpCode() },
    });

    expect(response.status).toBe(200);
    expect(fixture.database["session"]?.length).toBe(sessionsBefore + 1);
  });
});
