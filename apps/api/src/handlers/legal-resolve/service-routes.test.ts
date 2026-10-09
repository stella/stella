import { Result } from "better-result";
import { expect, test } from "bun:test";
import Elysia from "elysia";

import { createLegalResolveRoute } from "@/api/handlers/legal-resolve/routes";
import type { recordLegalResolveAudit } from "@/api/lib/auth/legal-resolve-audit";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";

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
