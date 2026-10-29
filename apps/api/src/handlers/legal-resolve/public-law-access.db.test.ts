import { Result } from "better-result";
import { afterAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { organization } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createLegalResolveRoute } from "@/api/handlers/legal-resolve/routes";
import { createHttpApp } from "@/api/http/app";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { createTestState } from "@/api/tests/helpers/test-state";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

const now = new Date("2026-10-11T00:00:00Z");
const standings = [
  ...Object.values(ORGANIZATION_ACCESS_STATE),
  "missing",
] as const;
const fixtures = standings.map((state) => ({
  state,
  organizationId: mintAuthProviderId<"organization">(),
}));
let db: TestDatabase;
const testState = createTestState({ file: import.meta.path, config: env });

testState.beforeAll(async () => {
  db = await getTestDb();
  await db.insert(organization).values(
    fixtures.map(({ organizationId }) => ({
      id: organizationId,
      name: "Public read fixture",
      slug: organizationId,
      createdAt: now,
    })),
  );
  for (const { state, organizationId } of fixtures) {
    switch (state) {
      case "missing":
        break;
      case ORGANIZATION_ACCESS_STATE.selfManagedKeys:
        await db
          .insert(organizationAccessStates)
          .values({ organizationId, state });
        break;
      case ORGANIZATION_ACCESS_STATE.evaluationPeriod:
        await db.insert(organizationAccessStates).values({
          organizationId,
          state,
          evaluationStartedAt: now,
          evaluationEndsAt: new Date(now.getTime() + 1),
        });
        break;
      case ORGANIZATION_ACCESS_STATE.evaluationEnded:
        await db.insert(organizationAccessStates).values({
          organizationId,
          state,
          evaluationStartedAt: new Date(now.getTime() - 2),
          evaluationEndsAt: new Date(now.getTime() - 1),
          evaluationEndedAt: now,
        });
        break;
    }
  }
});

afterAll(async () => {
  await db.delete(organization).where(
    inArray(
      organization.id,
      fixtures.map(({ organizationId }) => organizationId),
    ),
  );
  await releaseTestDb();
});

const decision = {
  status: "resolved",
  document: {
    kind: "decision",
    textState: null,
    decisionId: "fixture-decision",
    identifier: "fixture",
    country: "CZE",
    caseNumber: "fixture",
    ecli: null,
    court: "Fixture court",
    decisionDate: null,
    language: "en",
    languageAlternates: [],
    readerUrl: "/case/fixture",
    text: {
      status: "readable",
      blocks: [{ text: "Public decision text" }],
      extent: { type: "complete" },
    },
  },
} as const satisfies LegalResolveResponse;
const provision = {
  status: "resolved",
  document: {
    kind: "provision",
    documentId: "fixture-statute",
    eli: "fixture",
    country: "CZE",
    title: "Fixture statute",
    section: "1",
    readerUrl: "/law/fixture",
    inForce: { from: null, to: null },
    versionStatus: "current",
    blocks: [{ text: "Public provision text" }],
  },
} as const satisfies LegalResolveResponse;

test.each(
  fixtures.flatMap((fixture) =>
    [false, true].flatMap((enabled) =>
      ["user", "service"].map((principalType) => ({
        ...fixture,
        enabled,
        principalType,
      })),
    ),
  ),
)(
  "authenticated $principalType decision and provision resolution admits $state with enforcement $enabled",
  async ({ organizationId, enabled, principalType }) => {
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_ORG_ACCESS_STATE", enabled);
    try {
      const context = new InMemoryRateLimitContext();
      await using app = serveForTest(
        createHttpApp({
          routes: createLegalResolveRoute({
            authenticate: async () =>
              Result.ok(
                principalType === "service"
                  ? {
                      type: "service" as const,
                      clientId: "fixture-client",
                      organizationId,
                      scopes: ["stella:law_read"],
                      requestsPerMinute: 10,
                      dailyBudget: 100,
                    }
                  : {
                      organizationId,
                      userId: "fixture-user",
                      scopes: ["stella:law_read"],
                    },
              ),
            publicLawEnabled: () => true,
            resolveSessionContext: async () => ({}),
            recordAudit: async () => undefined,
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
            resolveDecision: async () => decision,
            resolveLaw: async () => provision,
          }),
          middleware: [errorBoundary],
        }),
      );
      for (const [url, expected] of [
        ["/case/CZE/decisions/resolve?identifier=fixture", decision],
        ["/law/CZE/citations/resolve?citation=fixture", provision],
      ] as const) {
        const response = await app.fetch(
          new Request(`http://localhost${url}`, {
            headers: { authorization: "Bearer fixture" },
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      }
    } finally {
      restore();
    }
  },
);
