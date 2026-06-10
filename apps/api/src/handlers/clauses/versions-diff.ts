import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildLineDiffSegments } from "@/api/lib/text-diff";

import { loadClauseVersionDiffSources } from "./version-diff";

const clauseVersionDiffParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
  versionId: tSafeId("clauseVersion"),
});

const config = {
  permissions: { workspace: ["read"] },
  params: clauseVersionDiffParamsSchema,
} satisfies HandlerConfig;

/**
 * Plain-text line diff of a stored clause version against the
 * clause's current version. Backs the "what changed" disclosure on
 * outdated template links; an empty segment list means the texts are
 * identical.
 */
const clauseVersionDiff = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params }) {
    const sources = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await loadClauseVersionDiffSources({
            scopedDb,
            organizationId: session.activeOrganizationId,
            clauseId: params.clauseId,
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

    return Result.ok({
      segments: buildLineDiffSegments(sources.prevText, sources.currentText),
    });
  },
);

export default clauseVersionDiff;
