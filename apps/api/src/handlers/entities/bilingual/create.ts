/**
 * Create a two-column bilingual copy of a DOCX document.
 *
 * Loads the entity's current DOCX, lays the body out as a source | target
 * table with per-language numbering (folio's `createBilingualDocx`), and
 * saves the result as a new entity through `createEntityFromBuffer` so it
 * gets the usual scan, indexing, audit and derivative treatment. The right
 * column starts as a copy of the source; translation fills it in later.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { createBilingualDocx } from "@stll/folio-core/server";

import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { buildBilingualFileName } from "@/api/lib/document-translation/output";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-docx-buffer";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { withTimeout } from "@/api/lib/with-timeout";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const CONVERSION_TIMEOUT_MS = 60_000;

/** IETF-style language tag; doubles as the cloned style suffix in folio. */
const LANGUAGE_TAG_PATTERN = "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$";

const languageTag = t.String({
  minLength: 2,
  maxLength: 16,
  pattern: LANGUAGE_TAG_PATTERN,
});

const createBilingualBody = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
  sourceLang: languageTag,
  targetLang: languageTag,
  borders: t.Optional(t.Union([t.Literal("none"), t.Literal("grid")])),
});

const config = {
  description:
    "Create a two-column bilingual copy of a DOCX document (source text on the left, a copy to translate on the right) as a new document.",
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "document_processing" },
  body: createBilingualBody,
} satisfies HandlerConfig;

const createBilingualEntity = createSafeHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    session,
    workspaceId,
    user,
    body,
    recordAuditEvent,
    request,
  }) {
    if (body.sourceLang.toLowerCase() === body.targetLang.toLowerCase()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Source and target language must differ",
        }),
      );
    }

    const loaded = yield* Result.await(
      loadEntityVersionDocxBuffer({
        safeDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        entityId: body.entityId,
        fileFieldId: body.fieldId,
        // Only the bytes are read; the copy becomes a separate document.
        allowReadOnly: true,
      }),
    );

    const conversion = await Result.tryPromise({
      try: async () =>
        await withTimeout(
          async () =>
            await createBilingualDocx(loaded.buffer, {
              targetStyleSuffix: body.targetLang,
              borders: body.borders ?? "none",
            }),
          {
            label: "bilingual-docx",
            signal: request.signal,
            timeoutMs: CONVERSION_TIMEOUT_MS,
          },
        ),
      catch: (error: unknown) => error,
    });

    if (conversion.isErr()) {
      captureError(conversion.error, { source: "bilingual-document" });
      return Result.err(
        new HandlerError({
          status: 422,
          message: "The document could not be laid out as a bilingual table",
        }),
      );
    }

    const { buffer, rows, warnings } = conversion.value;
    const fileName = buildBilingualFileName({
      sourceFileName: loaded.fileName,
      sourceLang: body.sourceLang,
      targetLang: body.targetLang,
    });

    const validation = await validateDocxBuffer(buffer);
    if (!validation.valid) {
      captureError(new Error(validation.error), {
        source: "bilingual-document",
      });
      return Result.err(
        new HandlerError({
          status: 422,
          message: "The bilingual document failed validation",
        }),
      );
    }

    const scanResult = await scanFile({
      buffer: new Uint8Array(buffer),
      declaredMimeType: DOCX_MIME_TYPE,
      fileName,
    });
    if (Result.isError(scanResult)) {
      captureError(scanResult.error, { source: "bilingual-document" });
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Bilingual document security scan failed",
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
          message: `Bilingual document rejected: ${reasons.join("; ")}`,
        }),
      );
    }

    const created = await createEntityFromBuffer({
      scopedDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      buffer,
      fileName,
      mimeType: DOCX_MIME_TYPE,
      scanWarnings: getScanWarnings(scanResult.value) ?? undefined,
    });
    if (Result.isError(created)) {
      return Result.err(
        new HandlerError({ status: 400, message: created.error.message }),
      );
    }

    return Result.ok({
      entityId: created.value.entityId,
      fieldId: created.value.fieldId,
      fileName: created.value.fileName,
      rowCount: rows.length,
      warnings,
    });
  },
);

export default createBilingualEntity;
