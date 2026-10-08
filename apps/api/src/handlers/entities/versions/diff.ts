import { Result } from "better-result";

import { loadEntityVersionDiffSources } from "@/api/handlers/entities/version-diff-sources";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import {
  FLOW_TASK_FEATURE_ACCESS,
  admitTaskFlowAccess,
} from "@/api/lib/flows/review-gate-task";
import { buildLineDiffSegments } from "@/api/lib/text-diff";

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Returns a parsed version comparison rather than stored-file bytes.",
  },
  description:
    "Return a plain-text, line-level diff of one document version's DOCX " +
    "against its immediate predecessor; the first version is diffed against " +
    "an empty document. Both texts are resolved server-side from the ids, " +
    "and an empty segment list means nothing changed. Use " +
    "documents.compare for a DOCX redline between versions you " +
    "choose.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: FLOW_TASK_FEATURE_ACCESS,
  mcp: { type: "covered", by: "read_document" },
  access: "read",
  params: workspaceParams({
    entityId: tSafeId("entity"),
    versionId: tSafeId("entityVersion"),
  }),
} satisfies WorkspaceHandlerConfig;

/**
 * Plain-text line diff of an entity version's DOCX against its
 * predecessor (the first version diffs against an empty document).
 * Content is resolved server-side from the version IDs after the
 * workspace check; an empty segment list means nothing changed.
 */
const versionDiff = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, session, user }) {
    const admission = yield* Result.await(
      safeDb(
        async (tx) =>
          await admitTaskFlowAccess(tx, {
            workspaceId,
            taskEntityId: params.entityId,
            userId: user.id,
          }),
      ),
    );
    yield* admission;
    const sources = yield* loadEntityVersionDiffSources({
      safeDb,
      workspaceId,
      organizationId: session.activeOrganizationId,
      entityId: params.entityId,
      versionId: params.versionId,
    });

    return Result.ok({
      segments: buildLineDiffSegments(sources.prevText, sources.currentText),
    });
  },
);

export default versionDiff;
