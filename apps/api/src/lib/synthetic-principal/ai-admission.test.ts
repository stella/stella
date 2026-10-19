import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { env } from "@/api/env";
import { ownAIKeyRequiredError } from "@/api/lib/ai-config-response";
import { assertModelDispatchScope } from "@/api/lib/rate-limit/model-dispatch-admission";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
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

const entryPoints = {
  model: async () => await resolveTanStackTextModel(options),
  text: async () =>
    await generateTanStackTextForTask({
      ...options,
      finishPolicy: "require-complete",
    }),
  structured: async () =>
    await generateTanStackObjectForTask({
      ...options,
      outputSchema: v.object({ answer: v.string() }),
    }),
  stream: async () => {
    const chunks: string[] = [];
    for await (const chunk of streamTanStackTextForTask(options)) {
      chunks.push(chunk);
    }
    return chunks;
  },
};

describe("monitoring model admission", () => {
  for (const feature of [false, true]) {
    for (const personalKey of [false, true]) {
      test(`model entries refuse monitoring work with access state ${feature} and personal key ${personalKey}`, async () => {
        state.setConfig("FEATURE_ORG_ACCESS_STATE", feature);
        state.setConfig("REQUIRE_PERSONAL_AI_KEY", personalKey);
        for (const run of Object.values(entryPoints)) {
          expect(await rejectionOf(run())).toMatchObject({
            status: 403,
            message: ownAIKeyRequiredError().message,
          });
        }
        const ordinaryOrg = mintAuthProviderId<"organization">();
        expect(() =>
          assertModelDispatchScope({
            organizationId: ordinaryOrg,
            admission: testModelAdmission(ordinaryOrg),
          }),
        ).not.toThrow();
      });
    }
  }
});
