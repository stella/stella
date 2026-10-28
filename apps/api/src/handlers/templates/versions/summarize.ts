import { Result } from "better-result";
import * as v from "valibot";

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { summarizeVersionChange } from "@/api/lib/entity-versions/version-change-summary";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { loadTemplateVersionDiffSources } from "../versions";

const templateVersionSummarizeParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
  versionId: resourceIdSchema("templateVersion"),
});

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "versions.summarize" },
  contentDelivery: {
    type: "none",
    reason:
      "Processes template content and returns parsed data or saved-document metadata rather than stored-file bytes.",
  },
  description:
    "Summarize in prose what changed in one template version compared with " +
    "its predecessor, over the same diff templates.versions.diff returns. " +
    "Returns summary null when the two are identical, skipping the model " +
    "call. Consumes AI usage.",
  permissions: { workspace: ["read"], chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: true,
  },
  access: "write",
  params: templateVersionSummarizeParamsSchema,
  requiresUsage: { actionType: "chat", modelTask: "short-text" },
} satisfies HandlerConfig;

/**
 * AI summary of what changed in a template version compared to its
 * predecessor. Both versions are resolved server-side from the IDs
 * after the ownership check; the client never supplies diff text.
 * Returns `summary: null` when the versions are identical.
 */
const templateVersionSummarize = createSafeRootHandler(
  config,
  async function* ({
    orgAIConfigStatus,
    modelAdmission,
    scopedDb,
    session,
    params,
    safeDb,
    user,
    orgAIConfig,
    managedAIResidency,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError(undefined));
    }

    const organizationId = session.activeOrganizationId;

    const sources = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await loadTemplateVersionDiffSources({
            scopedDb,
            organizationId,
            templateId: params.templateId,
            versionId: params.versionId,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to compute version diff",
            cause,
          }),
      }),
    );

    if (sources.type === "not-found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Version not found" }),
      );
    }
    if (sources.type === "unreadable") {
      return Result.err(sources.error);
    }

    const summary = yield* Result.await(
      summarizeVersionChange({
        admission: configuredModelAdmission({ modelAdmission }),
        prevText: sources.prevText,
        currentText: sources.currentText,
        feature: "templates.version_summary",
        orgAIConfig,
        managedAIResidency,
        organizationId,
        safeDb,
        userId: user.id,
        workspaceId: null,
      }),
    );

    return Result.ok({ summary });
  },
);

export default templateVersionSummarize;
