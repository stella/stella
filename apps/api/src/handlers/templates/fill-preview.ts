import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tJsonObject, tSafeId } from "@/api/lib/custom-schema";
import { fillPreviewLogic } from "@/api/lib/templates/fill-preview-logic";

const fillPreviewBodySchema = t.Object({
  values: tJsonObject,
});

const fillPreviewParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  description:
    "Run the full fill of a stored template with the given values and return " +
    "text instead of a file: the filled paragraphs, the character count, " +
    "placeholders no value matched, values no marker used, and any " +
    "structural errors. It does the same work as a real fill, AI-drafted " +
    "fields included, so it is not a cheap dry run. values is an object " +
    "mapping each field path to its value. Use templates.fill-by-id to " +
    "download the document.",
  // Same `use` grant as the REST fill routes: this runs the full stored-template
  // substitution pipeline (rendering filled paragraphs and consuming AI-fill
  // usage), so a read-only role must not reach it.
  permissions: { template: ["use"] },
  access: "read",
  mcp: { type: "covered", by: "fill_template" },
  params: fillPreviewParamsSchema,
  body: fillPreviewBodySchema,
} satisfies HandlerConfig;

const fillTemplatePreview = createSafeRootHandler(
  config,
  async function* ({ safeDb, scopedDb, session, user, params, body }) {
    const preview = yield* Result.await(
      fillPreviewLogic({
        safeDb,
        scopedDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        templateId: params.templateId,
        body,
      }),
    );
    return Result.ok(preview);
  },
);

export default fillTemplatePreview;
