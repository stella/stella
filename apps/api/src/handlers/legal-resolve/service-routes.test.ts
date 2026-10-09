import { Result } from "better-result";
import { expect, test } from "bun:test";
import Elysia from "elysia";

import { authorizeLegalResolveRequest } from "@/api/handlers/legal-resolve/authorization";
import {
  createLegalResolveRoute,
  createLegalResolveRateLimitOptions,
} from "@/api/handlers/legal-resolve/routes";
import type { recordLegalResolveAudit } from "@/api/lib/auth/legal-resolve-audit";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { OrganizationAccessReadError } from "@/api/lib/usage/organization-access-state";

const principal = {
  type: "service",
  clientId: "synthetic-client",
  organizationId: "synthetic-organization",
  scopes: ["stella:law_read"],
  requestsPerMinute: 1,
  dailyBudget: 2,
} as const;

test("service resolve calls authenticate once and audit outcomes without query text", async () => {
  const audits: Parameters<typeof recordLegalResolveAudit>[0][] = [];
  let authentications = 0;
  const limit = (scope: string) => ({
    context: new InMemoryRateLimitContext(),
    duration: 60_000,
    generator: () => scope,
    max: 1,
  });
  const app = new Elysia().use(
    createLegalResolveRoute({
      authenticate: async () => {
        authentications += 1;
        return Result.ok({ ...principal, scopes: [...principal.scopes] });
      },
      publicLawEnabled: () => true,
      mayReadPublicLaw: async () => Result.ok(true),
      recordAudit: async (input) => {
        audits.push(input);
      },
      decisionRateLimit: limit("decision"),
      lawRateLimit: limit("law"),
      resolveDecision: async () => ({ status: "country_unavailable" }),
      resolveLaw: async () => ({ status: "country_unavailable" }),
    }),
  );
  const call = async (path: string) =>
    await app.handle(
      new Request(`http://localhost${path}`, {
        headers: { authorization: "Bearer synthetic" },
      }),
    );
  expect(
    (await call("/case/CZ/decisions/resolve?identifier=synthetic-query"))
      .status,
  ).toBe(200);
  expect(
    (await call("/law/SK/citations/resolve?citation=synthetic-query")).status,
  ).toBe(200);
  expect(
    (await call("/law/SK/citations/resolve?citation=synthetic-query")).status,
  ).toBe(429);
  expect(authentications).toBe(3);
  expect(
    audits.map(({ route, country, outcome }) => ({ route, country, outcome })),
  ).toEqual([
    { route: "case", country: "CZE", outcome: "country_unavailable" },
    { route: "law", country: "SVK", outcome: "country_unavailable" },
    { route: "law", country: "SVK", outcome: "rate_limited" },
  ]);
  expect(JSON.stringify(audits)).not.toContain("synthetic-query");
  expect(JSON.stringify(audits)).not.toContain("Bearer");
});

test.each(
  (["service", "user"] as const).flatMap((type) =>
    (["not_entitled", "access_unavailable"] as const).map(
      (outcome) => [type, outcome] as const,
    ),
  ),
)(
  "organization admission is audited for %s principals with %s",
  async (type, outcome) => {
    const audits: Parameters<typeof recordLegalResolveAudit>[0][] = [];
    let resolveCalls = 0;
    let authentications = 0;
    let accessReads = 0;
    let userSessionReads = 0;
    const identity =
      type === "service"
        ? { ...principal, scopes: [...principal.scopes] }
        : {
            userId: "synthetic-user",
            organizationId: principal.organizationId,
            scopes: [...principal.scopes],
          };
    const context = new InMemoryRateLimitContext();
    const app = new Elysia().use(
      createLegalResolveRoute({
        authenticate: async () => {
          authentications += 1;
          return Result.ok(identity);
        },
        publicLawEnabled: () => true,
        resolveSessionContext: async (userSession) => {
          userSessionReads += 1;
          expect(userSession.userId).toBe("synthetic-user");
        },
        mayReadPublicLaw: async (org) => {
          accessReads += 1;
          expect(org).toBe(principal.organizationId);
          return outcome === "not_entitled"
            ? Result.ok(false)
            : Result.err(
                new OrganizationAccessReadError({
                  message: "Synthetic access read failure",
                  cause: new Error("Synthetic database failure"),
                }),
              );
        },
        recordAudit: async (event) => {
          audits.push(event);
        },
        decisionRateLimit: {
          context,
          duration: 60_000,
          generator: () => "decision",
          max: 10,
        },
        lawRateLimit: {
          context,
          duration: 60_000,
          generator: () => "law",
          max: 10,
        },
        resolveDecision: async () => {
          resolveCalls += 1;
          return { status: "country_unavailable" };
        },
      }),
    );
    const response = await app.handle(
      new Request(
        "http://localhost/case/CZ/decisions/resolve?identifier=synthetic",
        {
          headers: { authorization: "Bearer synthetic" },
        },
      ),
    );
    expect(response.status).toBe(outcome === "not_entitled" ? 403 : 503);
    expect(await response.json()).toEqual({ error: outcome });
    expect(resolveCalls).toBe(0);
    expect(authentications).toBe(1);
    expect(accessReads).toBe(1);
    expect(userSessionReads).toBe(type === "user" ? 1 : 0);
    expect(audits).toHaveLength(1);
    expect(audits.at(0)).toMatchObject({
      country: "CZE",
      route: "case",
      outcome: outcome === "not_entitled" ? "not_entitled" : "error",
      credentialKey: type === "service" ? principal.clientId : "synthetic-user",
    });
  },
);

test("route budgets come from each authorized service client", async () => {
  const options = createLegalResolveRateLimitOptions(
    "law",
    async (request) =>
      await authorizeLegalResolveRequest(
        new Request(request, {
          headers: { authorization: "Bearer synthetic" },
        }),
        {
          authenticate: async () =>
            Result.ok({
              ...principal,
              scopes: [...principal.scopes],
              clientId: request.headers.get("x-client") ?? "synthetic-client",
              requestsPerMinute:
                request.headers.get("x-client") === "small" ? 2 : 10,
              dailyBudget: request.headers.get("x-client") === "small" ? 3 : 20,
            }),
          publicLawEnabled: () => true,
          mayReadPublicLaw: async () => Result.ok(true),
        },
      ),
  );
  const small = new Request("http://localhost", {
    headers: { "x-client": "small" },
  });
  const large = new Request("http://localhost", {
    headers: { "x-client": "large" },
  });
  try {
    expect(await options.max(small)).toBe(2);
    expect(await options.max(large)).toBe(10);
    expect((await options.additionalBudgets(small)).at(0)).toMatchObject({
      max: 3,
      duration: 86_400_000,
    });
    expect((await options.additionalBudgets(large)).at(0)).toMatchObject({
      max: 20,
    });
    expect(await options.generator(small, null)).toContain(
      `${principal.organizationId}:small:law`,
    );
    expect(await options.generator(large, null)).toContain(
      `${principal.organizationId}:large:law`,
    );
  } finally {
    await options.context.kill();
  }
});
