import { Result } from "better-result";
import { t } from "elysia";

import { summarizeVersionDiff } from "@/api/lib/ai-change-summary";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildLineDiffSegments, diffSegmentsToText } from "@/api/lib/text-diff";

import { loadTemplateVersionDiffSources } from "./versions";

const templateVersionSummarizeParamsSchema = t.Object({
  templateId: tSafeId("template"),
  versionId: tSafeId("templateVersion"),
});

const config = {
  permissions: { workspace: ["read"] },
  params: templateVersionSummarizeParamsSchema,
} satisfies HandlerConfig;

/**
 * AI summary of what changed in a template version compared to its
 * predecessor. Both versions are resolved server-side from the IDs
 * after the ownership check; the client never supplies diff text.
 * Returns `summary: null` when the versions are identical.
 */
const templateVersionSummarize = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params }) {
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

    const segments = buildLineDiffSegments(
      sources.prevText,
      sources.currentText,
    );

    // Identical versions: nothing to summarize, skip the model call.
    let summary: string | null = null;
    if (segments.length > 0) {
      summary = yield* Result.await(
        Result.tryPromise({
          try: async () => {
            const orgAIConfig = await loadOrgAIConfig(organizationId);
            return await summarizeVersionDiff({
              diffText: diffSegmentsToText(segments),
              orgAIConfig,
              organizationId,
            });
          },
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Failed to summarize version changes",
              cause,
            }),
        }),
      );
    }

    return Result.ok({ summary });
  },
);

export default templateVersionSummarize;
