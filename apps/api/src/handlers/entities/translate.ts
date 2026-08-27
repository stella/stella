/**
 * Translate a stored document via DeepL.
 *
 * Resolves the org's stored DeepL key, downloads the source
 * field's bytes from S3, ships them to DeepL's /v2/document
 * flow, then writes the translated result back as a new
 * entity in the same workspace via the shared
 * `createEntityFromBuffer` path so the new file gets the
 * usual indexing, audit, and PDF-derivative treatment.
 */

import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { isDocumentTranslationDeepLSupportedMimeType } from "@stll/api-contract/document-translation";

import { entities, entityVersions, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { decryptContent } from "@/api/lib/content-encryption";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  DeepLAuthError,
  DeepLDocumentError,
  DeepLQuotaError,
  DeepLRateLimitError,
  DeepLTimeoutError,
  DeepLUpstreamError,
  translateDocument,
} from "@/api/lib/deepl/deepl";
import { resolveTranslatedOutput } from "@/api/lib/document-translation/output";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { createFileKey } from "@/api/lib/files/utils";
import { readS3ArrayBuffer } from "@/api/lib/s3";

const TRANSLATION_ERROR_CODE = {
  deeplKeyRejected: "deepl_key_rejected",
  deeplQuotaExceeded: "deepl_quota_exceeded",
} as const;

const translateBody = t.Object({
  fieldId: tSafeId("field"),
  targetLang: t.String({ minLength: 2, maxLength: 16 }),
  sourceLang: t.Optional(t.String({ minLength: 2, maxLength: 16 })),
  formality: t.Optional(
    t.Union([
      t.Literal("default"),
      t.Literal("more"),
      t.Literal("less"),
      t.Literal("prefer_more"),
      t.Literal("prefer_less"),
    ]),
  ),
});

const config = {
  description:
    "Translate a document file with the organization's configured translation provider and save the translated result as a new document.",
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "document_processing" },
  body: translateBody,
} satisfies HandlerConfig;

const translateEntity = createSafeHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    session,
    workspaceId,
    user,
    body,
    recordAuditEvent,
  }) {
    // 1. Resolve the org's DeepL key.
    const settingsRow = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            deeplApiKeyEncrypted: true,
            deeplApiKeyIv: true,
          },
        }),
      ),
    );

    const ciphertext = settingsRow?.deeplApiKeyEncrypted;
    const iv = settingsRow?.deeplApiKeyIv;
    if (!ciphertext || !iv) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "DeepL is not configured for this organisation. Add an API key in settings.",
        }),
      );
    }

    const apiKey = await decryptContent(
      session.activeOrganizationId,
      ciphertext,
      iv,
    );

    // 2. Look up the source field, scoped to this workspace.
    const fileRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ content: fields.content })
          .from(fields)
          .innerJoin(
            entityVersions,
            and(
              eq(fields.entityVersionId, entityVersions.id),
              isNull(entityVersions.deletedAt),
            ),
          )
          .innerJoin(
            entities,
            and(
              eq(entityVersions.entityId, entities.id),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .where(eq(fields.id, body.fieldId))
          .limit(1),
      ),
    );

    const fileRow = fileRows.at(0);
    if (!fileRow) {
      return Result.err(
        new HandlerError({ status: 404, message: "Source field not found" }),
      );
    }

    if (fileRow.content.type !== "file") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Field is not a file field",
        }),
      );
    }

    const sourceContent = fileRow.content;

    if (sourceContent.encrypted) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Encrypted files cannot be translated",
        }),
      );
    }

    if (!isDocumentTranslationDeepLSupportedMimeType(sourceContent.mimeType)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `DeepL does not support ${sourceContent.mimeType}`,
        }),
      );
    }

    // 3. Fetch source bytes through a presigned GET to avoid Bun's leaking
    // native S3 download path.
    const sourceKey = createFileKey({
      organizationId: session.activeOrganizationId,
      workspaceId,
      fileId: sourceContent.id,
      mimeType: sourceContent.mimeType,
    });

    const sourceBytesResult = await Result.tryPromise({
      try: async () => new Uint8Array(await readS3ArrayBuffer(sourceKey)),
      catch: (error: unknown) => error,
    });

    if (sourceBytesResult.isErr()) {
      captureError(sourceBytesResult.error);
      return Result.err(
        new HandlerError({
          status: 502,
          message: "Could not fetch the source file from storage",
        }),
      );
    }

    const sourceBytes = sourceBytesResult.value;

    // 4. Translate via DeepL.
    const translationResult = await Result.tryPromise({
      try: async () =>
        await translateDocument({
          apiKey,
          file: sourceBytes,
          fileName: sourceContent.fileName,
          mimeType: sourceContent.mimeType,
          targetLang: body.targetLang,
          sourceLang: body.sourceLang,
          // Pass `undefined` through when omitted so translateDocument applies
          // its documented `prefer_more` default (legal register), which the
          // translate dialog relies on. Do not default to "default" here.
          formality: body.formality,
        }),
      catch: (error: unknown) => error,
    });

    if (translationResult.isErr()) {
      const error = translationResult.error;
      if (DeepLAuthError.is(error)) {
        return Result.err(
          new HandlerError({
            code: TRANSLATION_ERROR_CODE.deeplKeyRejected,
            status: 400,
            message:
              "Stored DeepL key was rejected. Please rotate it in settings.",
          }),
        );
      }
      if (DeepLQuotaError.is(error)) {
        return Result.err(
          new HandlerError({
            code: TRANSLATION_ERROR_CODE.deeplQuotaExceeded,
            status: 402,
            message: "DeepL character quota exceeded for this organisation",
          }),
        );
      }
      if (DeepLRateLimitError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 429,
            message: "DeepL rate limit hit. Try again shortly.",
          }),
        );
      }
      if (DeepLTimeoutError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 502,
            message: "DeepL did not finish translating in time",
          }),
        );
      }
      if (DeepLDocumentError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: error.detail ?? "DeepL could not translate the document",
          }),
        );
      }
      if (DeepLUpstreamError.is(error)) {
        captureError(error);
        return Result.err(
          new HandlerError({
            status: 502,
            message: "DeepL request failed",
          }),
        );
      }
      throw error;
    }

    const translation = translationResult.value;
    const translatedOutput = resolveTranslatedOutput({
      sourceFileName: sourceContent.fileName,
      sourceMimeType: sourceContent.mimeType,
      targetLang: body.targetLang,
    });
    const scanResult = await scanFile({
      buffer: translation.bytes,
      declaredMimeType: translatedOutput.mimeType,
      fileName: translatedOutput.fileName,
    });

    if (Result.isError(scanResult)) {
      captureError(scanResult.error, {
        mimeType: translatedOutput.mimeType,
        source: "deepl-document-translation",
      });
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Translated file security scan failed",
        }),
      );
    }

    if (scanResult.value.verdict === "reject") {
      const reasons = scanResult.value.findings.flatMap((finding) =>
        finding.severity === "reject" ? [finding.message] : [],
      );
      return Result.err(
        new HandlerError({
          status: 422,
          message: `Translated file rejected: ${reasons.join("; ")}`,
        }),
      );
    }

    const scanWarnings = getScanWarnings(scanResult.value) ?? undefined;

    // 5. Write the result back as a new entity.
    const createResult = await createEntityFromBuffer({
      scopedDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      buffer: translation.bytes,
      fileName: translatedOutput.fileName,
      mimeType: translatedOutput.mimeType,
      scanWarnings,
    });

    if (Result.isError(createResult)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: createResult.error.message,
        }),
      );
    }

    return Result.ok({
      entityId: createResult.value.entityId,
      fieldId: createResult.value.fieldId,
      fileName: createResult.value.fileName,
      billedCharacters: translation.billedCharacters,
    });
  },
);

export default translateEntity;
