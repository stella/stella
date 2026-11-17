import { Result } from "better-result";

import type { OutlookAIDraftResponse } from "@stll/api-contract/outlook-ai";

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
  buildEmailDraftMessage,
  EMAIL_DRAFT_SYSTEM_PROMPT,
  EMAIL_GENERATION_TASK,
  generateEmailText,
} from "./email-generation";
import { draftEmailBodySchema } from "./schema";

const DRAFT_MAX_OUTPUT_TOKENS = 2048;

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "email.draft-reply" },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // The Outlook add-in's reply composer; agents write mail through their own
  // tools.
  mcp: { type: "internal", reason: "native_tool_ui" },
  body: draftEmailBodySchema,
  requiresUsage: { actionType: "chat", modelTask: EMAIL_GENERATION_TASK },
} satisfies HandlerConfig;

/**
 * A plain-text reply body for the email in the request, written to the
 * user's reply instruction. Persists nothing; the add-in inserts the draft.
 */
const draftEmail = createSafeRootHandler(
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
    const draft = yield* Result.await(
      generateEmailText({
        request: {
          system: EMAIL_DRAFT_SYSTEM_PROMPT,
          message: buildEmailDraftMessage(body),
          maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
          failureMessage: "Could not draft the email. Please try again.",
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
          feature: "email.draft_reply",
          modelTask: EMAIL_GENERATION_TASK,
          orgAIConfig,
          modelTier: admission.modelTier,
          properties: { organization_id: organizationId },
          traceId: Bun.randomUUIDv7(),
        }),
        abortSignal: actionSignal ?? request.signal,
      }),
    );

    return Result.ok({ draft } satisfies OutlookAIDraftResponse);
  },
);

declareAggregateMutation(draftEmail, {
  type: "independent",
  reason:
    "Generates text from the request body; writes only its own usage rows, with no cross-row invariant.",
});

export default draftEmail;
