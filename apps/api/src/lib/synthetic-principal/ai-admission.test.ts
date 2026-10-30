import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { env } from "@/api/env";
import { ownAIKeyRequiredError } from "@/api/lib/ai-config-response";
import {
  assertModelDispatchScope,
  type ModelDispatchScope,
  NO_ORGANIZATION_MODEL_DISPATCH,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  generateTanStackObjectForTask,
  generateTanStackTextForTask,
  resolveTanStackTextModel,
  streamTanStackTextForTask,
} from "@/api/lib/tanstack-ai-generate";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { createTestState } from "@/api/tests/helpers/test-state";

import { SYNTHETIC_PRINCIPAL } from "./constants";

const state = createTestState({ file: import.meta.path, config: env });
const organizationId = brandPersistedOrganizationId(SYNTHETIC_PRINCIPAL.org.id);
const options = {
  userId: null,
  organizationId,
  admission: testModelAdmission(organizationId),
  task: "chat",
  orgAIConfig: null,
  caching: { enabled: false, reason: "org-disabled" },
  dataClass: "customer",
  managedAIResidency: "eu",
  serviceTier: "standard",
  tenantWorkspaceIds: [],
  prompt: "Summarize the document.",
} as const;

const entryPoints = (scope: ModelDispatchScope) => {
  const dispatchOptions = { ...options, ...scope };
  return {
    model: async () => await resolveTanStackTextModel(dispatchOptions),
    text: async () =>
      await generateTanStackTextForTask({
        ...dispatchOptions,
        finishPolicy: "require-complete",
      }),
    structured: async () =>
      await generateTanStackObjectForTask({
        ...dispatchOptions,
        outputSchema: v.object({ answer: v.string() }),
      }),
    stream: async () => {
      const chunks: string[] = [];
      for await (const chunk of streamTanStackTextForTask(dispatchOptions)) {
        chunks.push(chunk);
      }
      return chunks;
    },
  };
};

describe("monitoring model admission", () => {
  for (const feature of [false, true]) {
    for (const personalKey of [false, true]) {
      test(`model entries refuse monitoring work with access state ${feature} and personal key ${personalKey}`, async () => {
        state.setConfig("FEATURE_ORG_ACCESS_STATE", feature);
        state.setConfig("REQUIRE_PERSONAL_AI_KEY", personalKey);
        const scopes = [
          {
            userId: null,
            organizationId,
            admission: testModelAdmission(organizationId),
          },
          {
            userId: brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
            organizationId: null,
            admission: NO_ORGANIZATION_MODEL_DISPATCH,
          },
        ] satisfies ModelDispatchScope[];
        for (const scope of scopes) {
          for (const run of Object.values(entryPoints(scope))) {
            expect(await rejectionOf(run())).toMatchObject({
              status: 403,
              message: ownAIKeyRequiredError().message,
            });
          }
        }
        const ordinaryOrg = mintAuthProviderId<"organization">();
        expect(() =>
          assertModelDispatchScope({
            userId: mintAuthProviderId<"user">(),
            organizationId: ordinaryOrg,
            admission: testModelAdmission(ordinaryOrg),
          }),
        ).not.toThrow();
        expect(() =>
          assertModelDispatchScope({
            userId: mintAuthProviderId<"user">(),
            organizationId: null,
            admission: NO_ORGANIZATION_MODEL_DISPATCH,
          }),
        ).not.toThrow();
      });
    }
  }
});
