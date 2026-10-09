import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { authorizeLegalResolveRequest } from "@/api/handlers/legal-resolve/authorization";
import { createLegalResolveRoute } from "@/api/handlers/legal-resolve/routes";
import { hasLawReadScope } from "@/api/handlers/legal-resolve/scope";
import {
  InMemoryRateLimitContext,
  type RateLimitOptions,
} from "@/api/lib/rate-limit/rate-limit";
import { OrganizationAccessReadError } from "@/api/lib/usage/organization-access-state";

const authorizationHeader = { authorization: "Bearer token" };
const session = {
  userId: "user",
  organizationId: "organization",
  scopes: ["stella:law_read"],
};

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
      mayReadPublicLaw: async () => Result.ok(true),
      publicLawEnabled: () => true,
      decisionRateLimit: limit("decision"),
      lawRateLimit: limit("law"),
      resolveDecision: async () => ({ status: "country_unavailable" }),
      resolveLaw: async () => ({ status: "country_unavailable" }),
    }),
  );

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
    },
  );
  expect(result).toEqual({ status: 403, body: { error: "missing_scope" } });
});

test("legal resolve distinguishes missing scope from organization entitlement", async () => {
  const request = new Request("http://localhost", {
    headers: { authorization: "Bearer token" },
  });
  const missingScope = await authorizeLegalResolveRequest(request, {
    authenticate: async () => Result.ok({ ...session, scopes: [] }),
    publicLawEnabled: () => true,
    mayReadPublicLaw: async () => Result.ok(true),
  });
  const notEntitled = await authorizeLegalResolveRequest(request, {
    authenticate: async () => Result.ok(session),
    publicLawEnabled: () => true,
    mayReadPublicLaw: async () => Result.ok(false),
  });

  expect(missingScope).toEqual({
    status: 403,
    body: { error: "missing_scope" },
  });
  expect(notEntitled).toEqual({
    status: 403,
    body: { error: "not_entitled" },
  });
});

test("an organization access read failure returns 503, never 200", async () => {
  const app = new Elysia().use(
    createLegalResolveRoute({
      authenticate: async () => Result.ok(session),
      publicLawEnabled: () => true,
      mayReadPublicLaw: async () =>
        Result.err(
          new OrganizationAccessReadError({
            message: "read failed",
            cause: new Error("database unavailable"),
          }),
        ),
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
      publicLawEnabled: () => true,
      mayReadPublicLaw: async () => {
        accessReadCount += 1;
        return Result.ok(true);
      },
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
