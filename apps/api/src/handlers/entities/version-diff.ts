import { Result } from "better-result";

import { loadEntityVersionDiffSources } from "@/api/handlers/entities/version-diff-sources";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { buildLineDiffSegments } from "@/api/lib/text-diff";

const config = {
  description:
    "Return a plain-text, line-level diff of one document version's DOCX " +
    "against its immediate predecessor; the first version is diffed against " +
    "an empty document. Both texts are resolved server-side from the ids, " +
    "and an empty segment list means nothing changed. Use " +
    "entities.compare-versions for a DOCX redline between two versions you " +
    "choose.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "read_document" },
  access: "read",
  params: workspaceParams({
    entityId: tSafeId("entity"),
    versionId: tSafeId("entityVersion"),
  }),
} satisfies HandlerConfig;

/**
 * Plain-text line diff of an entity version's DOCX against its
 * predecessor (the first version diffs against an empty document).
 * Content is resolved server-side from the version IDs after the
 * workspace check; an empty segment list means nothing changed.
 */
const versionDiff = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, session }) {
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
