import { describe, expect, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";
import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { flowDefinitions } from "@/api/db/schema";
import { env } from "@/api/env";
import startFlowRunHandler from "@/api/handlers/flows/runs/start";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("manual flow start admission response", () => {
  test("an unavailable admission configuration returns a typed refusal without inserting or auditing", async () => {
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const definitionId = createSafeId<"flowDefinition">();
    const definition = {
      id: definitionId,
      name: "Review document",
      enabled: true,
      createdByUserId: userId,
      steps: [
        {
          kind: "review-gate",
          name: "Review",
          instructions: "Review the document.",
        },
      ],
    } satisfies Pick<
      typeof flowDefinitions.$inferSelect,
      "id" | "name" | "enabled" | "createdByUserId" | "steps"
    >;
    let inserted = false;
    let audited = false;
    const safeDb = safeDbFromScoped(
      async (run) =>
        await run(
          asTestRaw({
            query: { flowDefinitions: { findFirst: async () => definition } },
            insert: () => ({
              values: async () => {
                inserted = true;
              },
            }),
          }),
        ),
    );
    const recordAuditEvent: AuditRecorder = async () => {
      audited = true;
    };
    const model = {
      provider: "openai",
      modelId: BYOK_DEFAULT_MODELS.openai.chat,
    } as const;
    const previousEnabled = env.FEATURE_ACTION_ADMISSION;
    const previousPeriodMs = env.ACTION_ADMISSION_PERIOD_MS;
    const previousPeriodActions = env.ACTION_ADMISSION_PERIOD_ACTIONS;
    env.FEATURE_ACTION_ADMISSION = true;
    env.ACTION_ADMISSION_PERIOD_MS = undefined;
    env.ACTION_ADMISSION_PERIOD_ACTIONS = undefined;
    try {
      const response = await startFlowRunHandler.handler(
        asTestRaw({
          request: new Request("https://example.test/flow-start"),
          route: "/flow-start",
          workspaceId,
          user: { id: userId },
          session: { activeOrganizationId: organizationId },
          memberRole: { role: "owner" },
          safeDb,
          body: { definitionId, inputEntityIds: [] },
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
          orgAIConfig: {
            providers: [{ provider: "openai", apiKey: "test-key" }],
            overrideModels: {
              chat: model,
              fast: model,
              pdf: model,
              reasoning: model,
            },
            decision: null,
          },
          recordAuditEvent,
          createAuditRecorder: () => recordAuditEvent,
        }),
      );
      expect(response).toMatchObject({
        code: 503,
        response: {
          code: ACTION_ADMISSION_CODES.admissionUnavailable,
          retryable: true,
        },
      });
      expect(inserted).toBe(false);
      expect(audited).toBe(false);
    } finally {
      env.FEATURE_ACTION_ADMISSION = previousEnabled;
      env.ACTION_ADMISSION_PERIOD_MS = previousPeriodMs;
      env.ACTION_ADMISSION_PERIOD_ACTIONS = previousPeriodActions;
    }
  });
});
