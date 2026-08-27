import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  documentTranslationRuns,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import { createDocumentTranslationRunBodySchema } from "@/api/handlers/document-translations/schemas";
import { captureError } from "@/api/lib/analytics/capture";
import {
  assertUsageAvailableForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import {
  DOCUMENT_TRANSLATION_ENGINE,
  DOCUMENT_TRANSLATION_OUTPUT,
  isExecutableTranslationCombination,
} from "@/api/lib/document-translation/contract";
import { isDeepLSupportedMimeType } from "@/api/lib/document-translation/deepl-formats";
import { inspectDocxComments } from "@/api/lib/document-translation/docx-review";
import { handoffCommittedDocumentTranslationRun } from "@/api/lib/document-translation/handoff";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createFileKey } from "@/api/lib/files/utils";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const config = {
  description:
    "Start a background document translation and save only the completed output as a new document.",
  permissions: { entity: ["create"] },
  access: "write",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  body: createDocumentTranslationRunBodySchema,
} satisfies HandlerConfig;

type CreateDocumentTranslationRunResult =
  | { type: "commentPolicyRequired" }
  | { type: "started"; runId: SafeId<"documentTranslationRun"> };

const createDocumentTranslationRun = createSafeHandler<
  typeof config,
  CreateDocumentTranslationRunResult
>(
  config,
  async function* ({
    body,
    orgAIConfig,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    if (!isExecutableTranslationCombination(body.output, body.engine)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Bilingual output is available with the AI engine only",
        }),
      );
    }
    const sources = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            entityVersionId: entityVersions.id,
            content: fields.content,
          })
          .from(entities)
          .innerJoin(
            entityVersions,
            and(
              eq(entityVersions.id, entities.currentVersionId),
              eq(entityVersions.entityId, entities.id),
              eq(entityVersions.workspaceId, workspaceId),
            ),
          )
          .innerJoin(
            fields,
            and(
              eq(fields.id, body.fieldId),
              eq(fields.entityVersionId, entityVersions.id),
            ),
          )
          .where(
            and(
              eq(entities.id, body.entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    );
    const source = sources.at(0);
    if (!source || source.content.type !== "file") {
      return Result.err(
        new HandlerError({ status: 404, message: "Source document not found" }),
      );
    }
    if (
      body.engine === DOCUMENT_TRANSLATION_ENGINE.AI &&
      body.entityVersionId !== source.entityVersionId
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "The document changed after translation was prepared. Reopen the translation dialog.",
        }),
      );
    }
    const sourceContent = source.content;
    if (sourceContent.encrypted) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Encrypted files cannot be translated",
        }),
      );
    }
    if (
      body.engine === DOCUMENT_TRANSLATION_ENGINE.AI &&
      sourceContent.mimeType !== DOCX_MIME_TYPE
    ) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Stella AI translation currently supports DOCX files only",
        }),
      );
    }
    if (
      body.engine === DOCUMENT_TRANSLATION_ENGINE.DEEPL &&
      !isDeepLSupportedMimeType(sourceContent.mimeType)
    ) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: `DeepL does not support ${sourceContent.mimeType}`,
        }),
      );
    }
    if (
      body.output === DOCUMENT_TRANSLATION_OUTPUT.BILINGUAL &&
      sourceContent.mimeType !== DOCX_MIME_TYPE
    ) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Bilingual output requires a DOCX file",
        }),
      );
    }
    if (
      body.commentPolicy !== undefined &&
      sourceContent.mimeType !== DOCX_MIME_TYPE
    ) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Comment translation policy requires a DOCX file",
        }),
      );
    }

    const organizationId = session.activeOrganizationId;
    const sourceFileId = brandPersistedUserFileId(sourceContent.id);
    if (
      sourceContent.mimeType === DOCX_MIME_TYPE &&
      body.commentPolicy === undefined
    ) {
      const inspection = await Result.tryPromise({
        try: async () => {
          const buffer = await readS3ArrayBuffer(
            createFileKey({
              organizationId,
              workspaceId,
              fileId: sourceFileId,
              mimeType: sourceContent.mimeType,
            }),
          );
          return await inspectDocxComments(buffer);
        },
        catch: (cause) => cause,
      });
      if (Result.isError(inspection)) {
        captureError(inspection.error, { entityId: body.entityId });
        return Result.err(
          new HandlerError({
            status: 422,
            message: "The DOCX file could not be inspected for comments",
          }),
        );
      }
      if (inspection.value.hasComments) {
        return Result.ok({ type: "commentPolicyRequired" as const });
      }
    }

    if (body.engine === DOCUMENT_TRANSLATION_ENGINE.AI) {
      const usageError = await assertUsageAvailableForHandler({
        metering: { actionType: "doc_review", modelRole: "chat" },
        organizationId,
        orgAIConfig,
        workspaceId,
        userId: user.id,
        safeDb,
      });
      if (usageError !== null) {
        return Result.err(usageError);
      }
    }

    const runId = createSafeId<"documentTranslationRun">();
    const inserted = yield* Result.await(
      safeDb(async (tx) => {
        const created = await tx
          .insert(documentTranslationRuns)
          .values({
            id: runId,
            organizationId,
            workspaceId,
            entityId: body.entityId,
            fileFieldId: body.fieldId,
            entityVersionId: source.entityVersionId,
            sourceFileId,
            sourceFileName: sourceContent.fileName,
            sourceMimeType: sourceContent.mimeType,
            output: body.output,
            engine: body.engine,
            commentPolicy: body.commentPolicy,
            sourceLang: body.sourceLang ?? "auto",
            targetLang: body.targetLang,
            requestedBy: user.id,
          })
          .onConflictDoNothing()
          .returning({ id: documentTranslationRuns.id });
        if (!created.at(0)) {
          return false;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_TRANSLATION_RUN,
          resourceId: runId,
          metadata: {
            entityId: body.entityId,
            output: body.output,
            engine: body.engine,
            targetLang: body.targetLang,
            commentPolicy: body.commentPolicy ?? null,
          },
        });
        return true;
      }),
    );
    if (!inserted) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "A translation of this document is already in progress",
        }),
      );
    }

    await handoffCommittedDocumentTranslationRun({
      runId,
      organizationId,
      workspaceId,
      userId: user.id,
    });
    return Result.ok({ type: "started" as const, runId });
  },
);

export default createDocumentTranslationRun;
