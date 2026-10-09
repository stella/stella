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
    },
  );
  expect(result).toEqual({ status: 403, body: { error: "missing_scope" } });
});

test("a legal resolve request authenticates its token once", async () => {
  let authenticationCount = 0;
  const app = routeApp(async () => {
    authenticationCount += 1;
    return Result.ok(session);
  });

  const response = await app.handle(
    new Request(
      "http://localhost/case/CZE/decisions/resolve?identifier=decision",
      { headers: authorizationHeader },
    ),
  );

  expect(response.status).toBe(200);
  expect(authenticationCount).toBe(1);
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
