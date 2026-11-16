import { Result } from "better-result";

import type { OutlookAISummaryResponse } from "@stll/api-contract/outlook-ai";

import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

import {
  buildEmailSummaryMessage,
  EMAIL_GENERATION_TASK,
  EMAIL_SUMMARY_SYSTEM_PROMPT,
  generateEmailText,
} from "./email-generation";
import { summarizeEmailBodySchema } from "./schema";

const SUMMARY_MAX_OUTPUT_TOKENS = 1024;

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "email.summarize" },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // The Outlook add-in's summary button; agents read and summarize mail
  // through their own tools.
  mcp: { type: "internal", reason: "native_tool_ui" },
  body: summarizeEmailBodySchema,
  requiresUsage: { actionType: "chat", modelTask: EMAIL_GENERATION_TASK },
} satisfies HandlerConfig;

/** A plain-text summary of the email text in the request. Persists nothing. */
const summarizeEmail = createSafeRootHandler(
  config,
  async function* ({
    actionSignal,
    body,
    managedAIResidency,
    modelAdmission,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
    }

    const organizationId = session.activeOrganizationId;
    const admission = configuredModelAdmission({ modelAdmission });
    const summary = yield* Result.await(
      generateEmailText({
        request: {
          system: EMAIL_SUMMARY_SYSTEM_PROMPT,
          message: buildEmailSummaryMessage(body),
          maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
          failureMessage: "Could not summarize the email. Please try again.",
        },
        admission,
        organizationId,
        userId: user.id,
        orgAIConfig,
        managedAIResidency,
        caching: resolveCaching({
          promptCachingEnabled,
          task: EMAIL_GENERATION_TASK,
          scopeKey: null,
        }),
        analytics: createTanStackAIAnalyticsCallbacks({
          dataClass: "customer",
          usageMetering: {
            actionType: "chat",
            organizationId,
            safeDb,
            serviceTier: "standard",
            userId: user.id,
            workspaceId: null,
          },
          feature: "email.summarize",
          modelTask: EMAIL_GENERATION_TASK,
          orgAIConfig,
          modelTier: admission.modelTier,
          properties: { organization_id: organizationId },
          traceId: Bun.randomUUIDv7(),
        }),
        abortSignal: actionSignal ?? request.signal,
      }),
    );

    return Result.ok({ summary } satisfies OutlookAISummaryResponse);
  },
);

declareAggregateMutation(summarizeEmail, {
  type: "independent",
  reason:
    "Generates text from the request body; writes only its own usage rows, with no cross-row invariant.",
});

export default summarizeEmail;
