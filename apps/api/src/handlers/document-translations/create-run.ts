import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  documentTranslationRuns,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import { createDocumentTranslationRunBodySchema } from "@/api/handlers/document-translations/schemas";
import {
  assertUsageAvailableForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import {
  DOCUMENT_TRANSLATION_ENGINE,
  DOCUMENT_TRANSLATION_OUTPUT,
  isExecutableTranslationCombination,
} from "@/api/lib/document-translation/contract";
import { isDeepLSupportedMimeType } from "@/api/lib/document-translation/deepl-formats";
import { handoffCommittedDocumentTranslationRun } from "@/api/lib/document-translation/handoff";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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

const createDocumentTranslationRun = createSafeHandler(
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
    if (
      body.engine === DOCUMENT_TRANSLATION_ENGINE.AI &&
      (body.sourceLang === undefined || body.sourceLang === "auto")
    ) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "AI translation requires a source language",
        }),
      );
    }

    if (body.engine === DOCUMENT_TRANSLATION_ENGINE.AI) {
      const usageError = await assertUsageAvailableForHandler({
        metering: { actionType: "doc_review", modelRole: "chat" },
        organizationId: session.activeOrganizationId,
        orgAIConfig,
        workspaceId,
        userId: user.id,
        safeDb,
      });
      if (usageError !== null) {
        return Result.err(usageError);
      }
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

    const organizationId = session.activeOrganizationId;
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
            sourceFileId: brandPersistedUserFileId(sourceContent.id),
            sourceFileName: sourceContent.fileName,
            sourceMimeType: sourceContent.mimeType,
            output: body.output,
            engine: body.engine,
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
    return Result.ok({ runId });
  },
);

export default createDocumentTranslationRun;
