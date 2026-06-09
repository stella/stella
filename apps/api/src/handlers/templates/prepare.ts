import { Result } from "better-result";
import { t } from "elysia";

import { prepareTemplateFromDocument } from "@/api/handlers/templates/prepare-template";
import { suggestTemplateFields } from "@/api/handlers/templates/suggest-template-fields";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const prepareBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

const config = {
  permissions: { workspace: ["read"] },
  body: prepareBodySchema,
} satisfies HandlerConfig;

/**
 * AI-prepare a template from a finished document: the model proposes which
 * values become fields, those literals are rewritten as `{{markers}}`, and a
 * manifest is embedded. Returns the prepared docx bytes (with the count of
 * suggestions that could not be applied in an `X-Unapplied-Count` header) for
 * the client to review and save as a template.
 */
const prepareTemplate = createSafeRootHandler(
  config,
  async function* ({ session, body }) {
    const { file } = body;
    if (file.type !== DOCX_MIME_TYPE) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid file type. Expected a DOCX file.",
        }),
      );
    }

    const prepared = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const orgAIConfig = await loadOrgAIConfig(
            session.activeOrganizationId,
          );
          const buffer = Buffer.from(await file.arrayBuffer());
          return await prepareTemplateFromDocument({
            buffer,
            suggest: async (documentText) =>
              await suggestTemplateFields({
                documentText,
                orgAIConfig,
                organizationId: session.activeOrganizationId,
              }),
          });
        },
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to prepare template from document",
            cause,
          }),
      }),
    );

    // Return the prepared docx as base64 in JSON, NOT a binary Response: Eden
    // parses binary responses as text and corrupts the zip (the same failure
    // the save round-trip hit). The client decodes this back to bytes.
    return Result.ok({
      docxBase64: prepared.buffer.toString("base64"),
      fieldCount: prepared.fields.length,
      unappliedCount: prepared.unapplied.length,
    });
  },
);

export default prepareTemplate;
