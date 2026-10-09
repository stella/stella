import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import {
  authorizeLegalResolveRequest,
  authorizeOncePerRequest,
} from "@/api/handlers/legal-resolve/authorization";
import { createLegalResolveRoute } from "@/api/handlers/legal-resolve/routes";
import { hasLawReadScope } from "@/api/handlers/legal-resolve/scope";
import {
  InMemoryRateLimitContext,
  type RateLimitOptions,
} from "@/api/lib/rate-limit/rate-limit";
import { OrganizationAccessReadError } from "@/api/lib/usage/public-law-access";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpOrganizationAccessError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

const authorizationHeader = { authorization: "Bearer token" };
const session = {
  userId: "user",
  organizationId: "organization",
  scopes: ["stella:law_read"],
};
const resolveSessionContext = async () => ({});
const tokenForAudience = (audience: string) =>
  `e30.${Buffer.from(JSON.stringify({ aud: audience })).toString("base64url")}.signature`;

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

const routeApp = (authenticate: () => Promise<Result<typeof session, never>>) =>
  new Elysia().use(
    createLegalResolveRoute({
      authenticate,
      recordAudit: async () => undefined,
      mayReadPublicLaw: async () => Result.ok(true),
      publicLawEnabled: () => true,
      resolveSessionContext,
      decisionRateLimit: limit("decision"),
      lawRateLimit: limit("law"),
      resolveDecision: async () => ({ status: "country_unavailable" }),
      resolveLaw: async () => ({ status: "country_unavailable" }),
    }),
  );

test("one request is authorized once, whoever asks first", async () => {
  const seen: Request[] = [];
  const authorize = authorizeOncePerRequest(async (request) => {
    seen.push(request);
    return await Promise.resolve({
      status: 403 as const,
      body: { error: "missing_scope" as const },
    });
  });
  const first = new Request("https://api.test/v1/law/cz/citations/resolve");
  const second = new Request("https://api.test/v1/law/cz/citations/resolve");

  await Promise.all([authorize(first), authorize(first)]);
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
        mayReadPublicLaw: async () => Result.ok(true),
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
      mayReadPublicLaw: async () => Result.ok(true),
      publicLawEnabled: () => true,
      resolveSessionContext,
    },
  );

  expect(result).toEqual({ status: 403, body: { error: "missing_scope" } });
  expect(authenticationCount).toBe(1);
});

test("legal resolve refuses a token after its live membership is removed", async () => {
  const result = await authorizeLegalResolveRequest(
    authorizationRequest(tokenForAudience(getMcpResourceUrl("law"))),
    {
      authenticate: async () => Result.ok({ ...session, memberId: "removed" }),
      mayReadPublicLaw: async () => Result.ok(true),
      publicLawEnabled: () => true,
      resolveSessionContext: async () => {
        throw new McpOrganizationAccessError({
          message: "User is not a member of this organization",
        });
      },
    },
  );

  expect(result).toEqual({ status: 403, body: { error: "missing_scope" } });
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

test("legal resolve reports token rejection as an uncaptured 403", async () => {
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

  expect(result).toEqual({ status: 403, body: { error: "missing_scope" } });
  expect(captured).toEqual([]);
});

test("legal resolve refuses access while the public-law plan state is off", async () => {
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
      mayReadPublicLaw: async () => Result.ok(true),
      resolveSessionContext,
    },
  );
  expect(result).toEqual({
    status: 403,
    session,
    body: { error: "missing_scope" },
  });
});

test("legal resolve distinguishes missing scope from organization entitlement", async () => {
  const request = new Request("http://localhost", {
    headers: { authorization: "Bearer token" },
  });
  const missingScope = await authorizeLegalResolveRequest(request, {
    authenticate: async () => Result.ok({ ...session, scopes: [] }),
    publicLawEnabled: () => true,
    mayReadPublicLaw: async () => Result.ok(true),
    resolveSessionContext,
  });
  const notEntitled = await authorizeLegalResolveRequest(request, {
    authenticate: async () => Result.ok(session),
    publicLawEnabled: () => true,
    mayReadPublicLaw: async () => Result.ok(false),
    resolveSessionContext,
  });

  expect(missingScope).toEqual({
    status: 403,
    session: { ...session, scopes: [] },
    body: { error: "missing_scope" },
  });
  expect(notEntitled).toEqual({
    status: 403,
    session,
    body: { error: "not_entitled" },
  });
});

test("the route returns 403 when the organization is not entitled", async () => {
  const app = new Elysia().use(
    createLegalResolveRoute({
      authenticate: async () => Result.ok(session),
      publicLawEnabled: () => true,
      mayReadPublicLaw: async () => Result.ok(false),
      resolveSessionContext,
      decisionRateLimit: limit("not-entitled-decision"),
      lawRateLimit: limit("not-entitled-law"),
    }),
  );

  const response = await app.handle(
    new Request(
      "http://localhost/case/CZE/decisions/resolve?identifier=decision",
      { headers: authorizationHeader },
    ),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "not_entitled" });
});

test("an organization access read failure returns 503, never 200", async () => {
  const app = new Elysia().use(
    createLegalResolveRoute({
      authenticate: async () => Result.ok(session),
      recordAudit: async () => undefined,
      publicLawEnabled: () => true,
      mayReadPublicLaw: async () =>
        Result.err(
          new OrganizationAccessReadError({
            message: "read failed",
            cause: new Error("database unavailable"),
          }),
        ),
      resolveSessionContext,
      decisionRateLimit: limit("failed-access-decision"),
      lawRateLimit: limit("failed-access-law"),
    }),
  );

  const response = await app.handle(
    new Request(
      "http://localhost/case/CZE/decisions/resolve?identifier=decision",
      { headers: authorizationHeader },
    ),
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "access_unavailable" });
});

test("a legal resolve request authenticates its token once", async () => {
  let authenticationCount = 0;
  let accessReadCount = 0;
  const app = new Elysia().use(
    createLegalResolveRoute({
      authenticate: async () => {
        authenticationCount += 1;
        return Result.ok(session);
      },
      recordAudit: async () => undefined,
      publicLawEnabled: () => true,
      mayReadPublicLaw: async () => {
        accessReadCount += 1;
        return Result.ok(true);
      },
      resolveSessionContext,
      decisionRateLimit: limit("one-read-decision"),
      lawRateLimit: limit("one-read-law"),
      resolveDecision: async () => ({ status: "country_unavailable" }),
    }),
  );

  const response = await app.handle(
    new Request(
      "http://localhost/case/CZE/decisions/resolve?identifier=decision",
      { headers: authorizationHeader },
    ),
  );

  expect(response.status).toBe(200);
  expect(authenticationCount).toBe(1);
  expect(accessReadCount).toBe(1);
});

test("decision and law routes consume separate rate-limit budgets", async () => {
  const app = routeApp(async () => Result.ok(session));
  const request = async (path: string) =>
    await app.handle(
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
