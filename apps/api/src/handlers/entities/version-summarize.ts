import { Result } from "better-result";

import { loadEntityVersionDiffSources } from "@/api/handlers/entities/version-diff-sources";
import { summarizeVersionDiff } from "@/api/lib/ai-change-summary";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
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
} satisfies HandlerConfig;

/**
 * AI summary of what changed in an entity version's DOCX compared
 * to its predecessor. Both versions are resolved server-side from
 * the IDs after the workspace check; the client never supplies diff
 * text. Returns `summary: null` when the versions are identical.
 */
const versionSummarize = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, session }) {
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

export default versionSummarize;
