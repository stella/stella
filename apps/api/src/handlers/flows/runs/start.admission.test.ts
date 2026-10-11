import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { flowDefinitions } from "@/api/db/schema";
import { env } from "@/api/env";
import startFlowRunHandler from "@/api/handlers/flows/runs/start";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import * as handlerErrorResolution from "@/api/lib/errors/handler-error-resolution";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import * as queuedActionAdmission from "@/api/lib/rate-limit/queued-action-admission";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("manual flow start admission response", () => {
  test.each([
    "busy",
    "period_exhausted",
    "not_enabled",
    "unavailable",
    "configuration_unavailable",
  ] as const)(
    "%s reaches shared resolution and returns its HTTP refusal without inserting or auditing",
    async (reason) => {
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
        modelId: BYOK_DEFAULT_MODELS.openai.chat.modelId,
      } as const;
      const refusal = new ActionAdmissionError({
        reason: reason === "configuration_unavailable" ? "unavailable" : reason,
        message: "Private admission detail",
      });
      const contactUrl = "https://example.test/contact";
      const expected = handlerErrorResolution.resolveHandlerError(
        refusal,
        contactUrl,
      );
      expect(expected).not.toBeNull();
      if (expected === null) {
        throw new TypeError(
          "Shared resolver must recognize an admission refusal",
        );
      }
      const kickoff =
        reason === "configuration_unavailable"
          ? null
          : spyOn(queuedActionAdmission, "runQueuedKickoff").mockRejectedValue(
              refusal,
            );
      const resolve = spyOn(handlerErrorResolution, "resolveHandlerError");
      const previousContactUrl = env.ACTION_LIMIT_CONTACT_URL;
      env.ACTION_LIMIT_CONTACT_URL = contactUrl;
      const previousEnabled = env.FEATURE_ACTION_ADMISSION;
      const previousPeriodMs = env.ACTION_ADMISSION_PERIOD_MS;
      const previousPeriodActions = env.ACTION_ADMISSION_PERIOD_ACTIONS;
      env.FEATURE_ACTION_ADMISSION = true;
      env.ACTION_ADMISSION_PERIOD_MS = undefined;
      env.ACTION_ADMISSION_PERIOD_ACTIONS = undefined;
      try {
        const app = new Elysia().post(
          "/flow-start",
          async ({ set, request }) =>
            await startFlowRunHandler.handler(
              asTestRaw({
                set,
                request,
                route: "/flow-start",
                workspaceId,
                user: { id: userId },
                session: { activeOrganizationId: organizationId },
                memberRole: sessionMemberRole("owner"),
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
            ),
        );
        const response = await app.handle(
          new Request("http://localhost/flow-start", { method: "POST" }),
        );
        if (kickoff !== null) {
          expect(kickoff).toHaveBeenCalledTimes(1);
          expect(resolve).toHaveBeenCalledWith(refusal, contactUrl);
        }
        expect(response.status).toBe(expected.status);
        expect(await response.json()).toEqual({
          code: expected.code,
          message: expected.message,
          hint: expected.hint,
          retryable: expected.retryable,
          ...(expected.contactUrl === undefined
            ? {}
            : { contactUrl: expected.contactUrl }),
        });
        expect(inserted).toBe(false);
        expect(audited).toBe(false);
      } finally {
        kickoff?.mockRestore();
        resolve.mockRestore();
        env.ACTION_LIMIT_CONTACT_URL = previousContactUrl;
        env.FEATURE_ACTION_ADMISSION = previousEnabled;
        env.ACTION_ADMISSION_PERIOD_MS = previousPeriodMs;
        env.ACTION_ADMISSION_PERIOD_ACTIONS = previousPeriodActions;
      }
    },
  );
});
