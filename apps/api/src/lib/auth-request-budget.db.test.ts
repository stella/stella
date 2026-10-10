import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { AUTH_RATE_LIMITS } from "@/api/lib/limits";
import {
  AUTH_ACCOUNT_REQUEST_BUDGET_RULES,
  AUTH_REQUEST_BUDGET_RULES,
} from "@/api/lib/rate-limit/auth-request-budget";
import { createHumanSession } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  grantOAuthClient,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

beforeAll(async () => {
  await initAgentAuthTestDb();
});
afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const createLimitedAuth = () => {
  const charges = new Map<string, number>();
  const storage = {
    consume: async (key: string) => {
      const count = (charges.get(key) ?? 0) + 1;
      charges.set(key, count);
      return { allowed: count <= 2, retryAfter: count <= 2 ? null : 60 };
    },
  };
  return {
    auth: createAuth(undefined, {
      rateLimitStorage: storage,
      rateLimitEnabled: true,
    }),
    charges,
  };
};
const request = (
  path: string,
  body: Record<string, string> | undefined,
  cookie?: string,
) =>
  new Request(getAuthEndpointUrl(path.slice(1)), {
    method: body ? "POST" : "GET",
    headers: {
      [AUTH_CLIENT_ADDRESS_HEADER]: "198.51.100.25",
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
  });
const registration = (callback: string) =>
  new Request(getAuthEndpointUrl("oauth2/register"), {
    method: "POST",
    headers: {
      [AUTH_CLIENT_ADDRESS_HEADER]: "198.51.100.25",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "Example client",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

describe("OAuth handler quotas", () => {
  test("every owned path disables the built-in IP quota", () => {
    const { auth } = createLimitedAuth();
    for (const path of Object.keys(AUTH_REQUEST_BUDGET_RULES)) {
      expect(auth.options.rateLimit?.customRules?.[path]).toBe(false);
    }
  });

  test("authorization budgets follow verified users behind one address", async () => {
    const { auth, charges } = createLimitedAuth();
    for (const name of ["first", "second"]) {
      const { browser } = await createHumanSession({
        email: `${name}-${Bun.randomUUIDv7()}@example.test`,
        orgName: "Quota example",
        orgSlugPrefix: "quota",
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await auth.handler(
          request("/oauth2/authorize", undefined, browser.cookieHeader()),
        );
        expect(response.status === 429).toBe(attempt === 2);
        if (attempt === 2) {
          expect(response.headers.get("Retry-After")).toBe("60");
        }
      }
    }
    expect(charges.size).toBe(2);
    expect(Array.from(charges.values())).toEqual([3, 3]);
  });

  test("registrations have callback quotas and a separate broad address ceiling", async () => {
    const charges = new Map<string, number>();
    // This test store leaves the broad address ceiling open while enforcing client budgets.
    const addressKeys = new Set<string>();
    const storage = {
      consume: async (key: string, rule: { max: number; window: number }) => {
        if (rule.max === 3000) {
          addressKeys.add(key);
          return { allowed: true, retryAfter: null };
        }
        const count = (charges.get(key) ?? 0) + 1;
        charges.set(key, count);
        return { allowed: count <= 2, retryAfter: count <= 2 ? null : 60 };
      },
    };
    const registrationAuth = createAuth(undefined, {
      rateLimitStorage: storage,
      rateLimitEnabled: true,
    });
    for (const callback of [
      "https://first.example/callback",
      "https://second.example/callback",
    ]) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await registrationAuth.handler(registration(callback));
        expect(response.status).toBe(attempt === 2 ? 429 : 200);
      }
    }
    expect(addressKeys.size).toBe(1);
    expect(charges.size).toBe(2);
  });

  test.each(Object.keys(AUTH_ACCOUNT_REQUEST_BUDGET_RULES))(
    "isolates %s account quotas at one shared address",
    async (path) => {
      const accounts = new Map<string, number>();
      const addresses = new Set<string>();
      const auth = createAuth(undefined, {
        rateLimitEnabled: true,
        rateLimitStorage: {
          consume: async (key, rule) => {
            if (rule.max === AUTH_RATE_LIMITS.authSharedAddress.max) {
              addresses.add(key);
              return { allowed: true, retryAfter: null };
            }
            expect(rule).toEqual(AUTH_RATE_LIMITS.signIn);
            const count = (accounts.get(key) ?? 0) + 1;
            accounts.set(key, count);
            return {
              allowed: count <= rule.max,
              retryAfter: count <= rule.max ? null : 60,
            };
          },
        },
      });
      for (const email of ["first@example.test", "second@example.test"]) {
        for (
          let attempt = 0;
          attempt <= AUTH_RATE_LIMITS.signIn.max;
          attempt += 1
        ) {
          const response = await auth.handler(
            request(path, {
              email,
              password: "incorrect-password",
              otp: "123456",
              type: "sign-in",
            }),
          );
          expect(response.status === 429).toBe(
            attempt === AUTH_RATE_LIMITS.signIn.max,
          );
        }
      }
      expect(accounts.size).toBe(2);
      expect(addresses.size).toBe(1);
    },
  );

  test("anonymous authorization uses the broad shared-address rule", async () => {
    const keys = new Set<string>();
    const auth = createAuth(undefined, {
      rateLimitEnabled: true,
      rateLimitStorage: {
        consume: async (key, rule) => {
          expect(rule).toEqual(AUTH_RATE_LIMITS.authSharedAddress);
          keys.add(key);
          return { allowed: true, retryAfter: null };
        },
      },
    });
    for (
      let attempt = 0;
      attempt <= AUTH_RATE_LIMITS.oauthAuthorization.max;
      attempt += 1
    ) {
      const response = await auth.handler(
        request("/oauth2/authorize", undefined),
      );
      expect(response.status).not.toBe(429);
    }
    expect(keys.size).toBe(1);
  });

  test("the anonymous registration address ceiling runs before the client counter", async () => {
    const calls: string[] = [];
    const auth = createAuth(undefined, {
      rateLimitEnabled: true,
      rateLimitStorage: {
        consume: async (key, rule) => {
          calls.push(key);
          expect(rule).toEqual(AUTH_RATE_LIMITS.oauthAnonymousAddress);
          return { allowed: false, retryAfter: 42 };
        },
      },
    });
    const response = await auth.handler(
      registration("https://limited.example/callback"),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(calls).toHaveLength(1);
  });

  test("an idempotent refresh replay retains the same user-client budget", async () => {
    const { auth, charges } = createLimitedAuth();
    const client = await registerOAuthClient(undefined, "none");
    const { browser } = await createHumanSession({
      email: `replay-quota-${Bun.randomUUIDv7()}@example.test`,
      orgName: "Replay quota",
      orgSlugPrefix: "replay-quota",
    });
    const grant = await grantOAuthClient(browser, client);
    const form = {
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      client_id: client.clientId,
    };
    const rotation = await auth.handler(request("/oauth2/token", form));
    expect(rotation.status).toBe(200);
    const tokens = v.parse(
      v.object({ access_token: v.string(), refresh_token: v.string() }),
      await rotation.json(),
    );
    const replay = await auth.handler(request("/oauth2/token", form));
    expect(replay.status).toBe(200);
    expect(
      v.parse(
        v.object({ access_token: v.string(), refresh_token: v.string() }),
        await replay.json(),
      ),
    ).toEqual(tokens);
    expect(charges.size).toBe(1);
    expect(Array.from(charges.values())).toEqual([2]);
    expect(
      (
        await auth.handler(
          request("/oauth2/token", {
            ...form,
            refresh_token: tokens.refresh_token,
          }),
        )
      ).status,
    ).toBe(429);
  });

  test("refresh quotas survive token rotation and isolate users of one client", async () => {
    const { auth, charges } = createLimitedAuth();
    const client = await registerOAuthClient(undefined, "none");
    for (const name of ["first", "second"]) {
      const { browser } = await createHumanSession({
        email: `refresh-${name}-${Bun.randomUUIDv7()}@example.test`,
        orgName: "Quota refresh",
        orgSlugPrefix: "quota-refresh",
      });
      const grant = await grantOAuthClient(browser, client);
      let token = grant.refreshToken;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await auth.handler(
          request("/oauth2/token", {
            grant_type: "refresh_token",
            refresh_token: token,
            client_id: client.clientId,
          }),
        );
        expect(response.status).toBe(attempt === 2 ? 429 : 200);
        if (attempt < 2) {
          const next = v.parse(
            v.object({ refresh_token: v.string() }),
            await response.json(),
          );
          expect(next.refresh_token).not.toBe(token);
          token = next.refresh_token;
        }
      }
    }
    expect(charges.size).toBe(2);
    expect(Array.from(charges.values())).toEqual([3, 3]);
  });
});
