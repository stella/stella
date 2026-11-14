import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildLineDiffSegments } from "@/api/lib/text-diff";

import { loadTemplateVersionDiffSources } from "../versions";

const templateVersionDiffParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
  versionId: resourceIdSchema("templateVersion"),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Processes template content and returns parsed data or saved-document metadata rather than stored-file bytes.",
  },
  description:
    "Return a plain-text, line-level diff of one template version against " +
    "its predecessor; the first version is diffed against an empty document. " +
    "Both texts are resolved server-side from the ids, and an empty segment " +
    "list means nothing changed.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  access: "read",
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
    if (sources.type === "unreadable") {
      return Result.err(sources.error);
    }

    return Result.ok({
      segments: buildLineDiffSegments(sources.prevText, sources.currentText),
    });
  },
);

export default templateVersionDiff;
