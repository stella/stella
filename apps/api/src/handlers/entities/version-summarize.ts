import { Result } from "better-result";

import { loadEntityVersionDiffSources } from "@/api/handlers/entities/version-diff-sources";
import { summarizeVersionDiff } from "@/api/lib/ai-change-summary";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildLineDiffSegments, diffSegmentsToText } from "@/api/lib/text-diff";

const config = {
  permissions: { workspace: ["read"] },
  params: workspaceParams({
    entityId: tSafeId("entity"),
    versionId: tSafeId("entityVersion"),
  }),
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

/**
 * AI summary of what changed in an entity version's DOCX compared
 * to its predecessor. Both versions are resolved server-side from
 * the IDs after the workspace check; the client never supplies diff
 * text. Returns `summary: null` when the versions are identical.
 */
const versionSummarize = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params,
    session,
    user,
    orgAIConfig,
  }) {
    const organizationId = session.activeOrganizationId;

    const sources = yield* loadEntityVersionDiffSources({
      safeDb,
      workspaceId,
      organizationId,
      entityId: params.entityId,
      versionId: params.versionId,
    });

    const segments = buildLineDiffSegments(
      sources.prevText,
      sources.currentText,
    );

    // Identical versions: nothing to summarize, skip the model call.
    let summary: string | null = null;
    if (segments.length > 0) {
      const aiAnalytics = createAIAnalyticsCallbacks({
        usageMetering: {
          actionType: "chat",
          organizationId,
          safeDb,
          serviceTier: "standard",
          userId: user.id,
          workspaceId,
        },
        feature: "entities.version_summary",
        modelRole: "fast",
        orgAIConfig,
        properties: { organization_id: organizationId },
        traceId: Bun.randomUUIDv7(),
      });

      summary = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await summarizeVersionDiff({
              diffText: diffSegmentsToText(segments),
              orgAIConfig,
              organizationId,
              aiAnalytics,
            }),
          catch: (cause) => {
            aiAnalytics.captureError(cause);
            return new HandlerError({
              status: 500,
              message: "Failed to summarize version changes",
              cause,
            });
          },
        }),
      );
    }

    return Result.ok({ summary });
  },
);

export default versionSummarize;
