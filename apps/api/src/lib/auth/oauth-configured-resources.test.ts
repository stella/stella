import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import { withConfiguredOAuthResources } from "@/api/lib/auth/oauth-configured-resources";

/**
 * The stored OAuth policy is shared by every release that runs against the
 * database, and the boot census accepts a stored policy that covers this
 * code's. These pin what that tolerance must not change: the code that is
 * running grants only the audiences and scopes it configures itself, whatever
 * a newer release stored beside them.
 */

const CLIENT_ID = "configured-resources-client";
const USER_ID = "configured-resources-user";
const REFRESH_VALUE = "configured-resources-refresh";
const RESOURCE = "https://resource.example.test/mcp";
const NEWER_RESOURCE = "https://resource.example.test/mcp/newer";
const NEWER_SCOPE = "newer_write";

/** What the running code configures: one audience, two scopes. */
const CONFIGURED = [
  { identifier: RESOURCE, allowedScopes: ["offline_access", "read"] },
] as const;

/**
 * A database a newer release has already migrated: it added a scope to the
 * audience this code serves, added an audience this code does not serve, and
 * registered a client and a grant that use both.
 */
const fixture = async ({ narrowed }: { narrowed: boolean }) => {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthClient: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
    oauthResource: [],
    oauthClientResource: [],
  };
  const stored = memoryAdapter(database);
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: narrowed
      ? (options) => withConfiguredOAuthResources(stored(options), CONFIGURED)
      : stored,
    rateLimit: { enabled: false },
    plugins: [
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        disableJwtPlugin: true,
        resourceSeedMode: "none",
        scopes: ["offline_access", "read"],
        storeTokens: { hash: async (value) => sha256Hex(value) },
      }),
    ],
  });
  const context = await auth.$context;
  const now = new Date();
  database["user"]?.push({
    id: USER_ID,
    name: "Fixture user",
    email: "configured-resources@example.test",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  for (const [identifier, allowedScopes] of [
    [RESOURCE, ["offline_access", "read", NEWER_SCOPE]],
    [NEWER_RESOURCE, ["offline_access", "read", NEWER_SCOPE]],
  ] as const) {
    database["oauthResource"]?.push({
      id: identifier,
      identifier,
      name: identifier,
      allowedScopes: [...allowedScopes],
      disabled: false,
      dpopBoundAccessTokensRequired: false,
      createdAt: now,
      updatedAt: now,
    });
    database["oauthClientResource"]?.push({
      id: `${CLIENT_ID}:${identifier}`,
      clientId: CLIENT_ID,
      resourceId: identifier,
      createdAt: now,
    });
  }
  await context.adapter.create({
    model: "oauthClient",
    data: {
      clientId: CLIENT_ID,
      tokenEndpointAuthMethod: "none",
      scopes: ["offline_access", "read", NEWER_SCOPE],
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: ["https://client.example.test/callback"],
      disabled: false,
    },
  });
  const refresh = async (resources: readonly string[]) => {
    database["oauthRefreshToken"] = [];
    await context.adapter.create({
      model: "oauthRefreshToken",
      data: {
        token: sha256Hex(REFRESH_VALUE),
        clientId: CLIENT_ID,
        authorizationCodeId: sha256Hex(`${REFRESH_VALUE}:code`),
        userId: USER_ID,
        scopes: ["offline_access", "read", NEWER_SCOPE],
        resources: [...resources],
        expiresAt: new Date("2100-01-01"),
        createdAt: new Date(0),
      },
    });
    return await auth.handler(
      new Request("http://localhost:3001/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: REFRESH_VALUE,
        }),
      }),
    );
  };
  return { context, refresh };
};

describe("OAuth resources as the running code configures them", () => {
  test("the stored policy alone would grant a scope this code never configured", async () => {
    // The control: without the narrowing, the newer release's scope flows
    // straight into a token this code issues.
    const { refresh } = await fixture({ narrowed: false });
    const response = await refresh([RESOURCE]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scope: `offline_access read ${NEWER_SCOPE}`,
    });
  });

  test("a scope a newer release added to a served audience is not issued", async () => {
    const { refresh } = await fixture({ narrowed: true });
    const response = await refresh([RESOURCE]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scope: "offline_access read",
    });
  });

  test("an audience a newer release added is not served", async () => {
    const { refresh } = await fixture({ narrowed: true });
    const response = await refresh([NEWER_RESOURCE]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
  });

  test("every read of the resource model is narrowed, in and out of a transaction", async () => {
    const { context } = await fixture({ narrowed: true });
    const expected = [
      expect.objectContaining({
        identifier: RESOURCE,
        allowedScopes: ["offline_access", "read"],
      }),
    ];
    expect(await context.adapter.findMany({ model: "oauthResource" })).toEqual(
      expected,
    );
    expect(
      await context.adapter.findOne({
        model: "oauthResource",
        where: [{ field: "identifier", value: NEWER_RESOURCE }],
      }),
    ).toBeNull();
    expect(
      await context.adapter.transaction(
        async (transaction) =>
          await transaction.findMany({ model: "oauthResource" }),
      ),
    ).toEqual(expected);
    // Other models pass through untouched.
    expect(
      await context.adapter.findMany({ model: "oauthClientResource" }),
    ).toHaveLength(2);
  });

  test("a stored row without a scope restriction carries exactly the configured scopes", async () => {
    const { context } = await fixture({ narrowed: true });
    await context.adapter.update({
      model: "oauthResource",
      where: [{ field: "identifier", value: RESOURCE }],
      update: { allowedScopes: null },
    });
    expect(
      await context.adapter.findOne({
        model: "oauthResource",
        where: [{ field: "identifier", value: RESOURCE }],
      }),
    ).toMatchObject({ allowedScopes: ["offline_access", "read"] });
  });
});
