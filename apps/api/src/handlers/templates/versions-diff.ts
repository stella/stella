import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildLineDiffSegments } from "@/api/lib/text-diff";

import { loadTemplateVersionDiffSources } from "./versions";

const templateVersionDiffParamsSchema = t.Object({
  templateId: tSafeId("template"),
  versionId: tSafeId("templateVersion"),
});

const config = {
  permissions: { workspace: ["read"] },
  params: templateVersionDiffParamsSchema,
} satisfies HandlerConfig;

/**
 * Plain-text line diff of a template version against its
 * predecessor (the first version diffs against an empty document).
 * Content is resolved server-side from the version IDs after the
 * ownership check; an empty segment list means nothing changed.
 */
const templateVersionDiff = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params }) {
    const sources = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await loadTemplateVersionDiffSources({
            scopedDb,
            organizationId: session.activeOrganizationId,
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

    return Result.ok({
      segments: buildLineDiffSegments(sources.prevText, sources.currentText),
    });
  },
);

export default templateVersionDiff;
