import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "@stll/sha256/bun";

import { createAuthRefusalLogPlugin } from "@/api/lib/auth/auth-request-observability";
import {
  describeOAuthTokenRefusal,
  OAUTH_CLIENT_ID_ATTRIBUTE_MAX_LENGTH,
  OAUTH_PROTOCOL_REFUSAL_REASONS,
  OAUTH_TOKEN_REFUSAL_REASONS,
} from "@/api/lib/auth/oauth-token-refusal";
import {
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import { runWithRequestId } from "@/api/lib/observability/request-context";

const CLIENT_ID = "refusal-client";
const REFRESH_VALUE = "fixture-refresh-value";
const CODE_VALUE = "fixture-code-value";
const SECRET_VALUE = "fixture-client-secret";
const VERIFIER_VALUE = "fixture-code-verifier";
const RESOURCE = "https://resource.example.test/mcp";
const REDIRECT = "https://client.example.test/callback";
const FAMILY_ID = sha256Hex(CODE_VALUE);
const FAMILY_HASH = sha256Hex(`stella:oauth:grant-family:v1:${FAMILY_ID}`);

afterEach(resetLogSinkForTesting);

const fixture = async () => {
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
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(database),
    rateLimit: { enabled: false },
    plugins: [
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        disableJwtPlugin: true,
        resourceSeedMode: "none",
        scopes: ["offline_access", "read"],
        storeTokens: { hash: async (value) => sha256Hex(value) },
        refreshTokenReuseInterval: 30,
      }),
      createAuthRefusalLogPlugin(createAuthMiddleware),
    ],
  });
  const context = await auth.$context;
  await context.adapter.create({
    model: "oauthClient",
    data: {
      clientId: CLIENT_ID,
      tokenEndpointAuthMethod: "none",
      scopes: ["offline_access", "read"],
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [REDIRECT],
      disabled: false,
    },
  });
  const seedRefresh = async (fields: Record<string, unknown> = {}) =>
    await context.adapter.create({
      model: "oauthRefreshToken",
      data: {
        token: sha256Hex(REFRESH_VALUE),
        clientId: CLIENT_ID,
        authorizationCodeId: FAMILY_ID,
        userId: "fixture-user",
        scopes: ["offline_access", "read"],
        resources: null,
        expiresAt: new Date("2100-01-01"),
        createdAt: new Date(0),
        ...fields,
      },
    });
  const seedCode = async (fields: Record<string, unknown> = {}) =>
    await context.internalAdapter.createVerificationValue({
      identifier: FAMILY_ID,
      value: JSON.stringify({
        type: "authorization_code",
        userId: "fixture-user",
        sessionId: "fixture-session",
        query: {
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT,
          scope: "offline_access read",
          code_challenge: "fixture-challenge",
          code_challenge_method: "S256",
          resource: RESOURCE,
        },
        ...fields,
      }),
      expiresAt: new Date("2100-01-01"),
    });
  const refuse = async (body: Record<string, string>) => {
    const response = await runWithRequestId(
      "fixture-request-id",
      async () =>
        await auth.handler(
          new Request("http://localhost:3001/api/auth/oauth2/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(body),
          }),
        ),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const refusals = records.filter(
      (record) => record.message === "auth.request_refused",
    );
    expect(refusals).toHaveLength(1);
    const attributes = refusals.at(0)?.attributes;
    expect(attributes).toMatchObject({
      "http.status_code": response.status,
      "request.id": "fixture-request-id",
      "auth.path": "/oauth2/token",
    });
    const serialized = JSON.stringify(refusals);
    for (const credential of [
      REFRESH_VALUE,
      CODE_VALUE,
      SECRET_VALUE,
      VERIFIER_VALUE,
      FAMILY_ID,
    ]) {
      expect(serialized).not.toContain(credential);
    }
    expect(serialized).not.toContain("error_description");
    expect(await response.text()).not.toContain("oauth.refusal_reason");
    return attributes;
  };
  return { context, database, seedRefresh, seedCode, refuse };
};

const refreshBody = {
  grant_type: "refresh_token",
  client_id: CLIENT_ID,
  refresh_token: REFRESH_VALUE,
};
const codeBody = {
  grant_type: "authorization_code",
  client_id: CLIENT_ID,
  code: CODE_VALUE,
  code_verifier: VERIFIER_VALUE,
  redirect_uri: REDIRECT,
};

describe("OAuth token refusal observations", () => {
  test("records the expired refusal reason", async () => {
    const { seedRefresh, refuse } = await fixture();
    await seedRefresh({ expiresAt: new Date(0) });
    expect(await refuse(refreshBody)).toMatchObject({
      "oauth.refusal_reason": "expired",
      "oauth.client_id": CLIENT_ID,
      "oauth.grant_family": FAMILY_HASH,
    });
  });

  test("observes invalid client authentication with the public client id", async () => {
    const { seedRefresh, refuse } = await fixture();
    await seedRefresh();
    expect(
      await refuse({ ...refreshBody, client_secret: SECRET_VALUE }),
    ).toMatchObject({
      "oauth.refusal_reason": "client_authentication_failed",
      "oauth.client_id": CLIENT_ID,
    });
  });

  test("observes a missing required request field before grant lookup", async () => {
    const { refuse } = await fixture();
    expect(
      await refuse({ grant_type: "refresh_token", client_id: CLIENT_ID }),
    ).toMatchObject({
      "oauth.refusal_reason": "request_invalid",
      "oauth.grant_family": "none",
    });
  });

  test("observes a malformed stored code value", async () => {
    const { context, seedCode, refuse } = await fixture();
    await seedCode();
    await context.adapter.update({
      model: "verification",
      where: [{ field: "identifier", value: FAMILY_ID }],
      update: { value: "{}" },
    });
    expect(await refuse(codeBody)).toMatchObject({
      "oauth.refusal_reason": "code_malformed",
    });
  });

  test("records the code_invalid refusal reason", async () => {
    const { refuse } = await fixture();
    expect(await refuse(codeBody)).toMatchObject({
      "oauth.refusal_reason": "code_invalid",
      "oauth.grant_family": FAMILY_HASH,
    });
  });

  test("represents a missing family identifier as none", () => {
    expect(
      describeOAuthTokenRefusal({
        observation: { reason: "expired", clientId: CLIENT_ID, familyId: null },
        body: refreshBody,
        errorCode: "invalid_grant",
      }),
    ).toMatchObject({ "oauth.grant_family": "none" });
  });

  test("keeps a printable client id within the bound, including a URL", () => {
    for (const clientId of [
      CLIENT_ID,
      "https://client.example.test/oauth/metadata.json",
      "x".repeat(OAUTH_CLIENT_ID_ATTRIBUTE_MAX_LENGTH),
    ]) {
      expect(
        describeOAuthTokenRefusal({
          observation: undefined,
          body: { grant_type: "refresh_token", client_id: clientId },
          errorCode: "invalid_client",
        }),
      ).toMatchObject({ "oauth.client_id": clientId });
    }
  });

  test("records an oversized or non-printable client id as a bounded digest", () => {
    const attributeFor = (clientId: string) =>
      describeOAuthTokenRefusal({
        observation: undefined,
        body: { grant_type: "refresh_token", client_id: clientId },
        errorCode: "invalid_client",
      })["oauth.client_id"];
    const oversized = "x".repeat(OAUTH_CLIENT_ID_ATTRIBUTE_MAX_LENGTH + 1);
    expect(attributeFor(oversized)).toBe(
      `sha256:${sha256Hex(`stella:oauth:client-id:v1:${oversized}`)}`,
    );
    for (const clientId of [
      oversized,
      "x".repeat(100_000),
      "client\nid",
      "client id",
      "klient-č",
      "",
    ]) {
      const attribute = attributeFor(clientId);
      expect(attribute).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(attribute).toBe(attributeFor(clientId));
    }
    expect(attributeFor("client\nid")).not.toBe(attributeFor("client\rid"));
  });

  test("surfaces an unclassified provider observation explicitly", () => {
    expect(
      describeOAuthTokenRefusal({
        observation: { reason: "new_provider_reason" },
        body: refreshBody,
        errorCode: "invalid_grant",
      }),
    ).toMatchObject({
      "oauth.refusal_reason": "unclassified",
      "oauth.refusal_unclassified": true,
    });
  });
});

const providerFile = async (pattern: string) => {
  const directory = new URL(
    ".",
    import.meta.resolve("@better-auth/oauth-provider"),
  );
  const matches = [...new Bun.Glob(pattern).scanSync(fileURLToPath(directory))];
  expect(matches).toHaveLength(1);
  const name = matches.at(0) ?? panic("Missing OAuth provider bundle");
  return Bun.file(new URL(name, directory)).text();
};

const providerFunction = (source: string, name: string) => {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.slice(start + 1).search(/\n(?:async )?function /u);
  return end < 0 ? source.slice(start) : source.slice(start, start + 1 + end);
};

const directRefusalsClassified = (source: string) =>
  !/throw new APIError[\w$]*\(/u.test(source) &&
  [...source.matchAll(/oauthTokenError\(ctx, (.*?), "[A-Z_]+",/gu)].every(
    (match) => {
      const reasons = [...(match.at(1) ?? "").matchAll(/"([a-z_]+)"/gu)];
      return (
        reasons.length > 0 &&
        reasons.every((reason) =>
          OAUTH_TOKEN_REFUSAL_REASONS.some((known) => known === reason.at(1)),
        )
      );
    },
  );

test("the pinned provider assigns every direct grant refusal and shared protocol error", async () => {
  const source = await providerFile("introspect-*.mjs");
  for (const name of [
    "checkVerificationValue",
    "handleAuthorizationCodeGrant",
    "handleRefreshTokenGrant",
    "createRefreshToken",
  ]) {
    const body = providerFunction(source, name);
    expect(body).toContain("oauthTokenError(ctx,");
    expect(directRefusalsClassified(body)).toBe(true);
    // The census itself must refuse an added unclassified path.
    expect(
      directRefusalsClassified(
        `${body}\nthrow new APIError("BAD_REQUEST", {});`,
      ),
    ).toBe(false);
    expect(
      directRefusalsClassified(body.replaceAll('"expired"', '"new_refusal"')),
    ).toBe(!body.includes('"expired"'));
  }
  const utils = await providerFile("utils-*.mjs");
  for (const [file, names] of [
    [
      source,
      [
        "tokenEndpoint",
        "resolveResourcePolicy",
        "assertClientLinkedToResources",
        "decodeRefreshToken",
        "throwInvalidDpopProof",
      ],
    ],
    [
      utils,
      [
        "extractClientCredentials",
        "validateClientCredentials",
        "validateClientScopes",
        "throwInvalidClient",
        "throwInvalidAuthenticationRequest",
      ],
    ],
  ] as const) {
    for (const name of names) {
      for (const match of providerFunction(file, name).matchAll(
        /error: "([a-z_]+)"/gu,
      )) {
        expect(
          Object.keys(OAUTH_PROTOCOL_REFUSAL_REASONS).some(
            (reason) => reason === match.at(1),
          ),
        ).toBe(true);
      }
    }
  }
});
