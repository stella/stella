import { panic, Result } from "better-result";
import { beforeEach, expect, test } from "bun:test";
import * as v from "valibot";

import { AI_FAILURE_CODES } from "@stll/api-contract";
import { createTestState } from "@stll/test-state";

import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { featureFlagSchema } from "@/api/env-base-schema";
import {
  citationCheckAdmission,
  createCheckCitation,
} from "@/api/handlers/case-law/citations/check";
import { caseLawRoute } from "@/api/handlers/case-law/routes";
import { HttpStatusResponse } from "@/api/http/status";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  CITATION_CHECK_FEATURE_ID,
  FEATURE_REGISTRY,
} from "@/api/lib/feature-access/registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { classifyRouteGate } from "@/api/lib/route-gates";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const testState = createTestState({ file: import.meta.path, config: env });
beforeEach(() => testState.setConfig("FEATURE_CITATION_CHECK", false));

const untouchedCorpus = asTestRaw<CaseLawPublicReadDb>(async () =>
  panic("A refused check read the corpus"),
);
const untouchedDb: SafeDb = async () =>
  panic("A refused check read the database");

test("an unset deployment flag leaves the citation check off", () => {
  expect(v.parse(featureFlagSchema, undefined)).toBe(false);
});

test("the check route runs the deployment gate, then the organization grant, before anything else", () => {
  const entry = caseLawRoute.find(
    (route) =>
      route.method === "POST" && route.path.endsWith("/case/citations/check"),
  );
  const gates = (entry ?? panic("Expected the citation check route")).middleware
    .map(classifyRouteGate)
    .filter((gate) => gate.kind !== "other");
  // The deployment gate answers like an absent route while the flag is off,
  // so nothing after it, the grant lookup included, runs.
  expect(gates.slice(0, 3)).toEqual([
    { kind: "deployment-feature", flag: "FEATURE_CITATION_CHECK" },
    { kind: "feature-access", featureId: CITATION_CHECK_FEATURE_ID },
    { kind: "budget" },
  ]);
});

test("a check without a usable decision model is refused before it starts", () => {
  const refused = citationCheckAdmission({
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    hasDecisionModel: () => false,
  });
  expect(Result.isError(refused) ? refused.error.status : null).toBe(403);

  const unreadable = citationCheckAdmission({
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
    hasDecisionModel: () => true,
  });
  expect(Result.isError(unreadable)).toBe(true);

  expect(
    Result.isOk(
      citationCheckAdmission({
        orgAIConfig: null,
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        hasDecisionModel: () => true,
      }),
    ),
  ).toBe(true);
});

test("the handler refuses an unconfigured deployment without reading the corpus", async () => {
  testState.setConfig("FEATURE_CITATION_CHECK", true);
  const principal = {
    organizationId: mintAuthProviderId<"organization">(),
    userId: mintAuthProviderId<"user">(),
  };
  // A member of a granted organization, so only the missing decision model
  // stands between the request and the corpus.
  const featureAccessSnapshot = createFeatureAccessSnapshot({
    ...principal,
    decisions: new Map([
      [
        CITATION_CHECK_FEATURE_ID,
        decideFeatureAccess({
          ...principal,
          registry: FEATURE_REGISTRY,
          featureId: CITATION_CHECK_FEATURE_ID,
          grants: {
            [CITATION_CHECK_FEATURE_ID]: [
              {
                type: "organization",
                organizationId: principal.organizationId,
              },
            ],
          },
          user: { email: "member@example.test", emailVerified: true },
          membership: true,
        }),
      ],
    ]),
  });
  const handler = createCheckCitation({
    caseLawDb: untouchedCorpus,
    hasDecisionModel: () => false,
  });
  const outcome = await handler.handler(
    asTestRaw<Parameters<typeof handler.handler>[0]>({
      body: { citation: "sp. zn. 21 Cdo 1234/2020", claim: "A sentence." },
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      session: { activeOrganizationId: principal.organizationId },
      user: { id: principal.userId },
      memberRole: sessionMemberRole("owner"),
      featureAccessSnapshot,
      safeDb: untouchedDb,
      request: new Request("https://api.example.test/v1/case/citations/check", {
        method: "POST",
      }),
      route: "/v1/case/citations/check",
    }),
  );
  expect(outcome).toBeInstanceOf(HttpStatusResponse);
  // Not the permission refusal: the decision-model one, read from the body.
  expect(outcome).toMatchObject({
    code: 403,
    response: { code: AI_FAILURE_CODES.role_not_configured },
  });
});
