import { Result } from "better-result";

import { prepareDocumentTranslationBodySchema } from "@/api/handlers/document-translations/schemas";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { inspectDocxComments } from "@/api/lib/document-translation/docx-review";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Inspect the current DOCX version and prepare its comment requirements for translation.",
  permissions: { entity: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "document_processing" },
  params: workspaceParams({}),
  body: prepareDocumentTranslationBodySchema,
} satisfies HandlerConfig;

type PrepareDocumentTranslationResult = {
  entityVersionId: SafeId<"entityVersion">;
  hasComments: boolean;
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
    try: async () => await inspectDocxComments(loaded.buffer),
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
  });
});

export default prepareDocumentTranslation;
