import { Result } from "better-result";

import type { DocumentTranslationSourceLanguageDetection } from "@stll/api-contract/document-translation";

import { prepareDocumentTranslationBodySchema } from "@/api/handlers/document-translations/schemas";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { readDocxDeclaredSourceLanguage } from "@/api/lib/document-translation/docx-language";
import { inspectDocxComments } from "@/api/lib/document-translation/docx-review";
import { resolveDocumentTranslationSourceLanguage } from "@/api/lib/document-translation/source-language";
import { extractText } from "@/api/lib/docx/extract-text";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-docx-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Inspect the current DOCX version and prepare its source-language and comment requirements for translation.",
  permissions: { entity: ["create"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  body: prepareDocumentTranslationBodySchema,
} satisfies HandlerConfig;

type PrepareDocumentTranslationResult = {
  entityVersionId: SafeId<"entityVersion">;
  hasComments: boolean;
  sourceLanguage: DocumentTranslationSourceLanguageDetection;
};

const prepareDocumentTranslation = createSafeHandler<
  typeof config,
  PrepareDocumentTranslationResult
>(config, async function* ({ body, safeDb, session, workspaceId }) {
  const loaded = yield* Result.await(
    loadEntityVersionDocxBuffer({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      entityId: body.entityId,
      fileFieldId: body.fieldId,
      allowReadOnly: true,
    }),
  );

  const inspection = await Result.tryPromise({
    try: async () => {
      const [comments, extracted, declaredLanguage] = await Promise.all([
        inspectDocxComments(loaded.buffer),
        extractText(new Uint8Array(loaded.buffer)),
        Result.tryPromise({
          try: async () => await readDocxDeclaredSourceLanguage(loaded.buffer),
          catch: (cause) => cause,
        }),
      ]);
      if (Result.isError(declaredLanguage)) {
        captureError(declaredLanguage.error, {
          source: "document-translation-docx-language",
        });
      }
      const text = extracted.paragraphs
        .map((paragraph) => paragraph.text)
        .join("\n");
      return {
        hasComments: comments.hasComments,
        sourceLanguage: resolveDocumentTranslationSourceLanguage({
          declaredLanguage: Result.isError(declaredLanguage)
            ? null
            : declaredLanguage.value,
          text,
        }),
      };
    },
    catch: (cause) => cause,
  });
  if (Result.isError(inspection)) {
    captureError(inspection.error, { source: "document-translation-prepare" });
    return Result.err(
      new HandlerError({
        status: 422,
        message: "The document could not be inspected for translation",
      }),
    );
  }

  return Result.ok({
    entityVersionId: loaded.entityVersionId,
    hasComments: inspection.value.hasComments,
    sourceLanguage: inspection.value.sourceLanguage,
  });
});

export default prepareDocumentTranslation;
