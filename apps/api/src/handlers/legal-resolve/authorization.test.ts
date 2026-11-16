import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { authenticateLegalResolveToken } from "@/api/handlers/legal-resolve/authentication";
import {
  authorizeLegalResolveRequest,
  authorizeOncePerRequest,
} from "@/api/handlers/legal-resolve/authorization";
import { createLegalResolveRoute } from "@/api/handlers/legal-resolve/routes";
import { hasLawReadScope } from "@/api/handlers/legal-resolve/scope";
import { createHttpApp } from "@/api/http/app";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import type { RateLimitOptions } from "@/api/lib/rate-limit/contracts";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpOrganizationAccessError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";
import { serveForTest } from "@/api/tests/helpers/test-server";

const authorizationHeader = { authorization: "Bearer token" };
const session = {
  userId: "user",
  organizationId: "organization",
  scopes: ["stella:law_read"],
};
const resolveSessionContext = async () => ({});
const tokenForAudience = (audience: string) =>
  `e30.${Buffer.from(JSON.stringify({ aud: audience })).toBase64({ alphabet: "base64url", omitPadding: true })}.signature`;

const authorizationRequest = (token: string) =>
  new Request("http://localhost", {
    headers: { authorization: `Bearer ${token}` },
  });

const limit = (scope: string): RateLimitOptions => ({
  context: new InMemoryRateLimitContext(),
  duration: 60_000,
  generator: () => scope,
  max: 1,
});

/** The legal resolve routes behind the error boundary, on a real server. */
const serveLegalResolve = (
  dependencies: Parameters<typeof createLegalResolveRoute>[0],
) =>
  serveForTest(
    createHttpApp({
      routes: createLegalResolveRoute(dependencies),
      middleware: [errorBoundary],
    }),
  );

const routeApp = (authenticate: typeof authenticateLegalResolveToken) =>
  serveLegalResolve({
    authenticate,
    recordAudit: async () => undefined,
    publicLawEnabled: () => true,
    resolveSessionContext,
    decisionRateLimit: limit("decision"),
    lawRateLimit: limit("law"),
    resolveDecision: async () => ({ status: "country_unavailable" }),
    resolveLaw: async () => ({ status: "country_unavailable" }),
  });

test("one request is authorized once, whoever asks first", async () => {
  const seen: Request[] = [];
  const authorize = authorizeOncePerRequest(async (request) => {
    seen.push(request);
    return await Promise.resolve({
      status: 401 as const,
      body: { error: "unauthorized" as const },
    });
  });
  const first = new Request("https://api.test/v1/law/cz/citations/resolve");
  const second = new Request("https://api.test/v1/law/cz/citations/resolve");

  expect(await authorize.getExistingAuthorization(first)).toBeUndefined();
  expect(seen).toEqual([]);
  await Promise.all([authorize(first), authorize(first)]);
  expect(await authorize.getExistingAuthorization(first)).toEqual({
    status: 401,
    body: { error: "unauthorized" },
  });
  expect(await authorize.getExistingAuthorization(second)).toBeUndefined();
  await authorize(first);
  await authorize(second);

  expect(seen).toEqual([first, second]);
});

test("an unexpected authorization throw is a captured 503, settled once", async () => {
  const failure = new Error("access store threw");
  const captured: unknown[] = [];
  let calls = 0;
  const authorize = authorizeOncePerRequest(
    async () => {
      calls += 1;
      return await Promise.reject(failure);
    },
    (error) => {
      captured.push(error);
    },
  );
  const request = new Request("https://api.test/v1/law/cz/citations/resolve");

  const first = await authorize(request);
  const second = await authorize(request);

  expect(first).toEqual({ status: 503, body: { error: "access_unavailable" } });
  expect(second).toEqual(first);
  expect(calls).toBe(1);
  expect(captured).toEqual([failure]);
});

describe("legal resolve scope", () => {
  test("accepts the law scope and its general-read superset", () => {
    expect(hasLawReadScope(["stella:law_read"])).toBe(true);
    expect(hasLawReadScope(["stella:read"])).toBe(true);
  });

  test("rejects unrelated and absent scopes", () => {
    expect(hasLawReadScope([])).toBe(false);
    expect(hasLawReadScope(["stella:search"])).toBe(false);
  });
});

test("legal resolve verifies law and default resource tokens against their own audience", async () => {
  for (const mode of ["law", "default"] as const) {
    const token = tokenForAudience(getMcpResourceUrl(mode));
    let authenticationCount = 0;
    const result = await authorizeLegalResolveRequest(
      authorizationRequest(token),
      {
        authenticate: async (receivedToken, options) => {
          authenticationCount += 1;
          expect(receivedToken).toBe(token);
          if (options === undefined) {
            return panic("Legal resolve authentication options are missing");
          }
          expect(options.mode).toBe(mode);
          return Result.ok(session);
        },
        publicLawEnabled: () => true,
        resolveSessionContext,
      },
    );

    expect(result.status).toBe(200);
    expect(authenticationCount).toBe(1);
  }
});

test("legal resolve rejects a token for another audience after one verification", async () => {
  const token = tokenForAudience("https://api.stll.app/not-law");
  let authenticationCount = 0;
  const result = await authorizeLegalResolveRequest(
    authorizationRequest(token),
    {
      authenticate: async (_receivedToken, options) => {
        authenticationCount += 1;
        if (options === undefined) {
          return panic("Legal resolve authentication options are missing");
        }
        expect(options.mode).toBe("law");
        return Result.err(
          new McpAuthenticationError({ message: "Wrong audience" }),
        );
      },
      publicLawEnabled: () => true,
      resolveSessionContext,
    },
  );

  expect(result).toEqual({ status: 401, body: { error: "unauthorized" } });
  expect(authenticationCount).toBe(1);
});

test("legal resolve refuses a token after its live membership is removed", async () => {
  const result = await authorizeLegalResolveRequest(
    authorizationRequest(tokenForAudience(getMcpResourceUrl("law"))),
    {
      authenticate: async () => Result.ok({ ...session, memberId: "removed" }),
      publicLawEnabled: () => true,
      resolveSessionContext: async () => {
        throw new McpOrganizationAccessError({
          message: "User is not a member of this organization",
        });
      },
    },
  );

  expect(result).toEqual({
    status: 403,
    session: { ...session, memberId: "removed" },
    body: { error: "missing_scope" },
  });
});

test("legal resolve reports verifier outages as a captured 503", async () => {
  const captured: unknown[] = [];
  const result = await authorizeLegalResolveRequest(
    authorizationRequest(tokenForAudience(getMcpResourceUrl("law"))),
    {
      authenticate: async () =>
        Result.err(
          new McpTokenVerificationError({ message: "JWKS unavailable" }),
        ),
      captureError: (error) => {
        captured.push(error);
      },
    },
  );

  expect(result).toEqual({
    status: 503,
    body: { error: "access_unavailable" },
  });
  expect(captured).toHaveLength(1);
  expect(captured.at(0)).toBeInstanceOf(McpTokenVerificationError);
});

test("legal resolve reports token rejection as an uncaptured 401", async () => {
  const captured: unknown[] = [];
  const result = await authorizeLegalResolveRequest(
    authorizationRequest(tokenForAudience(getMcpResourceUrl("law"))),
    {
      authenticate: async () =>
        Result.err(new McpAuthenticationError({ message: "Rejected" })),
      captureError: (error) => {
        captured.push(error);
      },
    },
  );

  expect(result).toEqual({ status: 401, body: { error: "unauthorized" } });
  expect(captured).toEqual([]);
});

test("legal resolve refuses access while the public-law deployment is off", async () => {
  const result = await authorizeLegalResolveRequest(
    new Request("http://localhost", {
      headers: { authorization: "Bearer token" },
    }),
    {
      authenticate: async () =>
        Result.ok({
          userId: "user",
          organizationId: "organization",
          scopes: ["stella:law_read"],
        }),
      publicLawEnabled: () => false,
      resolveSessionContext,
    },
  );
  expect(result).toEqual({
    status: 403,
    session,
    body: { error: "missing_scope" },
  });
});

test("a legal resolve request authenticates its token once", async () => {
  let authenticationCount = 0;
  await using app = serveLegalResolve({
    authenticate: async () => {
      authenticationCount += 1;
      return Result.ok(session);
    },
    recordAudit: async () => undefined,
    publicLawEnabled: () => true,
    resolveSessionContext,
    decisionRateLimit: limit("one-read-decision"),
    lawRateLimit: limit("one-read-law"),
    resolveDecision: async () => ({ status: "country_unavailable" }),
  });

  const response = await app.fetch(
    new Request(
      "http://localhost/case/CZE/decisions/resolve?identifier=decision",
      { headers: authorizationHeader },
    ),
  );

  expect(response.status).toBe(200);
  expect(authenticationCount).toBe(1);
});

test("decision and law routes consume separate rate-limit budgets", async () => {
  await using app = routeApp(async () => Result.ok(session));
  const request = async (path: string) =>
    await app.fetch(
      new Request(`http://localhost${path}`, { headers: authorizationHeader }),
    );

  expect(
    (await request("/case/CZE/decisions/resolve?identifier=decision")).status,
  ).toBe(200);
  expect(
    (await request("/law/CZE/citations/resolve?citation=law")).status,
  ).toBe(200);
  expect(
    (await request("/case/CZE/decisions/resolve?identifier=decision")).status,
  ).toBe(429);
  expect(
    (await request("/law/CZE/citations/resolve?citation=law")).status,
  ).toBe(429);
});

test("legal resolve captures live user-session outages and retains the audit principal", async () => {
  const captured: unknown[] = [];
  const result = await authorizeLegalResolveRequest(
    authorizationRequest("synthetic"),
    {
      authenticate: async () => Result.ok(session),
      resolveSessionContext: async () => {
        throw new TypeError("Synthetic session infrastructure outage");
      },
      captureError: (error) => {
        captured.push(error);
      },
    },
  );
  expect(result).toEqual({
    status: 503,
    session,
    body: { error: "access_unavailable" },
  });
  expect(captured).toHaveLength(1);
});

test.each([undefined, "Bearer rejected"])(
  "unauthenticated routes return a token challenge for %s",
  async (authorization) => {
    await using app = routeApp(async () =>
      Result.err(new McpAuthenticationError({ message: "Rejected" })),
    );
    const response = await app.fetch(
      new Request(
        "http://localhost/case/CZE/decisions/resolve?identifier=decision",
        { headers: authorization === undefined ? {} : { authorization } },
      ),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    const challenge = response.headers.get("WWW-Authenticate");
    expect(challenge).toContain("Bearer ");
    if (authorization === undefined) {
      expect(challenge).not.toContain("invalid_token");
    } else {
      expect(challenge).toContain('error="invalid_token"');
    }
  },
);
