import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { summarizeVersionChange } from "@/api/lib/entity-versions/version-change-summary";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { loadTemplateVersionDiffSources } from "../versions";

const templateVersionSummarizeParamsSchema = t.Object({
  templateId: tSafeId("template"),
  versionId: tSafeId("templateVersion"),
});

const config = {
  description:
    "Summarize in prose what changed in one template version compared with " +
    "its predecessor, over the same diff templates.versions.diff returns. " +
    "Returns summary null when the two are identical, skipping the model " +
    "call. Consumes AI usage.",
  permissions: { workspace: ["read"], chat: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "write",
  params: templateVersionSummarizeParamsSchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

/**
 * AI summary of what changed in a template version compared to its
 * predecessor. Both versions are resolved server-side from the IDs
 * after the ownership check; the client never supplies diff text.
 * Returns `summary: null` when the versions are identical.
 */
const templateVersionSummarize = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, safeDb, user, orgAIConfig }) {
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

    const summary = yield* Result.await(
      summarizeVersionChange({
        prevText: sources.prevText,
        currentText: sources.currentText,
        feature: "templates.version_summary",
        orgAIConfig,
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
