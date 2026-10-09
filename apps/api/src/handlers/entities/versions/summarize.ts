import { Result } from "better-result";

import { loadEntityVersionDiffSources } from "@/api/handlers/entities/version-diff-sources";
import { summarizeVersionDiff } from "@/api/lib/ai-change-summary";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildLineDiffSegments, diffSegmentsToText } from "@/api/lib/text-diff";

const config = {
  actionAdmission: { type: "handler", actionKind: "versions.summarize" },
  contentDelivery: {
    type: "none",
    reason: "Returns a version summary rather than stored-file bytes.",
  },
  description:
    "Summarize in prose what changed between one document version and its " +
    "predecessor, over the same server-resolved text diff " +
    "entities.versions.diff returns. Returns summary null for identical " +
    "versions, skipping the model call entirely. Consumes AI usage.",
  permissions: { workspace: ["read"], chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  access: "write",
  params: workspaceParams({
    entityId: tSafeId("entity"),
    versionId: tSafeId("entityVersion"),
  }),
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies WorkspaceHandlerConfig;

/**
 * AI summary of what changed in an entity version's DOCX compared
 * to its predecessor. Both versions are resolved server-side from
 * the IDs after the workspace check; the client never supplies diff
 * text. Returns `summary: null` when the versions are identical.
 */
const versionSummarize = createSafeHandler(
  config,
  async function* ({
    modelAdmission,
    safeDb,
    workspaceId,
    params,
    session,
    user,
    orgAIConfig,
    managedAIResidency,
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
      const aiAnalytics = createTanStackAIAnalyticsCallbacks({
        dataClass: "customer",
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
              admission: configuredModelAdmission({ modelAdmission }),
              diffText: diffSegmentsToText(segments),
              orgAIConfig,
              managedAIResidency,
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
