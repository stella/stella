import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  officeFileEvidence,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";
import { extractOfficeEvidence } from "@/api/lib/files/extract-office-evidence";
import {
  OFFICE_EVIDENCE_FORMAT,
  OFFICE_EVIDENCE_PARSER_VERSION,
  officeEvidencePayloadSchema,
  type OfficeEvidenceBlock,
  type OfficeEvidenceFormat,
  type OfficeEvidencePayload,
} from "@/api/lib/files/office-evidence-types";
import { createFileKey } from "@/api/lib/files/utils";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { PPTX_MIME_TYPE, XLSX_MIME_TYPE } from "@/api/mime-types";

type OfficeEvidenceSource = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  fileId: string;
  fileName: string;
  mimeType: string;
  sha256Hex: string;
};

type OfficeEvidenceScope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

type PersistedEvidenceRow = {
  blockCount: number;
  errorCode: string | null;
  format: OfficeEvidenceFormat;
  payloadCiphertext: Buffer | null;
  payloadIv: Buffer | null;
  status: "available" | "unavailable";
};

export const resolveOfficeEvidenceFormat = (
  mimeType: string,
): OfficeEvidenceFormat | null => {
  if (mimeType === XLSX_MIME_TYPE) {
    return OFFICE_EVIDENCE_FORMAT.xlsx;
  }
  return mimeType === PPTX_MIME_TYPE ? OFFICE_EVIDENCE_FORMAT.pptx : null;
};

const selectEvidenceRows = async (
  tx: Transaction,
  scope: OfficeEvidenceScope,
  source: OfficeEvidenceSource,
) =>
  await tx
    .select({
      blockCount: officeFileEvidence.blockCount,
      errorCode: officeFileEvidence.errorCode,
      format: officeFileEvidence.format,
      payloadCiphertext: officeFileEvidence.payloadCiphertext,
      payloadIv: officeFileEvidence.payloadIv,
      status: officeFileEvidence.status,
    })
    .from(officeFileEvidence)
    .where(
      and(
        eq(officeFileEvidence.organizationId, scope.organizationId),
        eq(officeFileEvidence.workspaceId, scope.workspaceId),
        eq(officeFileEvidence.entityVersionId, source.entityVersionId),
        eq(officeFileEvidence.fieldId, source.fieldId),
        eq(officeFileEvidence.sourceFileId, source.fileId),
        eq(officeFileEvidence.sourceSha256Hex, source.sha256Hex),
        eq(officeFileEvidence.parserVersion, OFFICE_EVIDENCE_PARSER_VERSION),
      ),
    )
    .limit(1);

const readEvidenceRows = async (
  scopedDb: ScopedDb,
  scope: OfficeEvidenceScope,
  source: OfficeEvidenceSource,
) => await scopedDb((tx) => selectEvidenceRows(tx, scope, source));

const decodeEvidenceRow = async (
  row: PersistedEvidenceRow,
  organizationId: SafeId<"organization">,
): Promise<OfficeEvidencePayload | null> => {
  if (
    row.status === "unavailable" ||
    !row.payloadCiphertext ||
    !row.payloadIv
  ) {
    return null;
  }

  const decryptResult = await Result.tryPromise({
    try: async () =>
      await decryptContent(
        organizationId,
        row.payloadCiphertext,
        row.payloadIv,
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(decryptResult)) {
    captureError(decryptResult.error, { operation: "office-evidence-decrypt" });
    return null;
  }
  const jsonResult = Result.try({
    try: () => JSON.parse(decryptResult.value) as unknown,
    catch: (cause) => cause,
  });
  if (Result.isError(jsonResult)) {
    captureError(jsonResult.error, { operation: "office-evidence-json" });
    return null;
  }
  const parsed = v.safeParse(officeEvidencePayloadSchema, jsonResult.value);
  if (
    !parsed.success ||
    parsed.output.blocks.length !== row.blockCount ||
    parsed.output.format !== row.format
  ) {
    captureError(
      new TelemetryError({
        message: "Persisted Office evidence failed validation",
      }),
      { operation: "office-evidence-validate" },
    );
    return null;
  }
  return parsed.output;
};

const isCurrentSource = async (
  tx: Transaction,
  scope: OfficeEvidenceScope,
  source: OfficeEvidenceSource,
): Promise<boolean> => {
  const rows = await tx
    .select({ content: fields.content })
    .from(entities)
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, entities.currentVersionId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      fields,
      and(
        eq(fields.entityVersionId, entityVersions.id),
        eq(fields.id, source.fieldId),
      ),
    )
    .where(
      and(
        eq(entities.id, source.entityId),
        eq(entities.workspaceId, scope.workspaceId),
        eq(entityVersions.id, source.entityVersionId),
      ),
    )
    .limit(1);
  const content = rows.at(0)?.content;
  return (
    content?.type === "file" &&
    content.id === source.fileId &&
    content.sha256Hex === source.sha256Hex
  );
};

type LoadOfficeEvidenceOptions = OfficeEvidenceScope & {
  safeDb: SafeDb;
  source: OfficeEvidenceSource;
};

/**
 * Lazily creates locator evidence for the exact active Office file. Failures
 * are best-effort: ordinary AnyDoc-backed file chat remains available.
 */
export const loadOfficeEvidence = async ({
  organizationId,
  safeDb,
  source,
  workspaceId,
}: LoadOfficeEvidenceOptions): Promise<OfficeEvidencePayload | null> => {
  const format = resolveOfficeEvidenceFormat(source.mimeType);
  if (!format) {
    return null;
  }
  const scope = { organizationId, workspaceId };
  const cachedResult = await safeDb((tx) =>
    selectEvidenceRows(tx, scope, source),
  );
  if (Result.isError(cachedResult)) {
    captureError(cachedResult.error, { operation: "office-evidence-read" });
    return null;
  }
  const cached = cachedResult.value.at(0);
  if (cached) {
    return await decodeEvidenceRow(cached, organizationId);
  }

  const readResult = await Result.tryPromise({
    try: async () =>
      await readS3ArrayBuffer(
        createFileKey({
          fileId: source.fileId,
          mimeType: source.mimeType,
          organizationId,
          workspaceId,
        }),
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(readResult)) {
    captureError(readResult.error, { operation: "office-evidence-file-read" });
    return null;
  }

  const extraction = await extractOfficeEvidence(readResult.value, format);
  if (Result.isError(extraction)) {
    captureError(extraction.error, { operation: "office-evidence-extract" });
    return null;
  }

  const encryptedResult =
    extraction.value.status === "available"
      ? await Result.tryPromise({
          try: async () =>
            await encryptContent(
              organizationId,
              JSON.stringify(extraction.value.payload),
            ),
          catch: (cause) => cause,
        })
      : Result.ok(null);
  if (Result.isError(encryptedResult)) {
    captureError(encryptedResult.error, {
      operation: "office-evidence-encrypt",
    });
    return null;
  }

  const persistResult = await safeDb(async (tx) => {
    if (!(await isCurrentSource(tx, scope, source))) {
      return null;
    }
    const value = extraction.value;
    if (value.status === "available") {
      const encrypted = encryptedResult.value;
      if (!encrypted) {
        return null;
      }
      await tx
        .insert(officeFileEvidence)
        .values({
          blockCount: value.payload.blocks.length,
          entityId: source.entityId,
          entityVersionId: source.entityVersionId,
          errorCode: null,
          fieldId: source.fieldId,
          format,
          organizationId,
          parserVersion: OFFICE_EVIDENCE_PARSER_VERSION,
          payloadCiphertext: encrypted.ciphertext,
          payloadIv: encrypted.iv,
          sourceFileId: source.fileId,
          sourceSha256Hex: source.sha256Hex,
          status: "available",
          workspaceId,
        })
        .onConflictDoNothing();
    } else {
      await tx
        .insert(officeFileEvidence)
        .values({
          blockCount: 0,
          entityId: source.entityId,
          entityVersionId: source.entityVersionId,
          errorCode: value.errorCode,
          fieldId: source.fieldId,
          format,
          organizationId,
          parserVersion: OFFICE_EVIDENCE_PARSER_VERSION,
          payloadCiphertext: null,
          payloadIv: null,
          sourceFileId: source.fileId,
          sourceSha256Hex: source.sha256Hex,
          status: "unavailable",
          workspaceId,
        })
        .onConflictDoNothing();
    }
    return await selectEvidenceRows(tx, scope, source);
  });
  if (Result.isError(persistResult)) {
    captureError(persistResult.error, { operation: "office-evidence-persist" });
    return null;
  }
  const persisted = persistResult.value?.at(0);
  return persisted ? await decodeEvidenceRow(persisted, organizationId) : null;
};

type FindCurrentOfficeEvidenceBlockOptions = OfficeEvidenceScope & {
  blockId: string;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  scopedDb: ScopedDb;
};

export const findCurrentOfficeEvidenceBlock = async ({
  blockId,
  entityId,
  fieldId,
  organizationId,
  scopedDb,
  workspaceId,
}: FindCurrentOfficeEvidenceBlockOptions): Promise<{
  block: OfficeEvidenceBlock;
  source: {
    entityId: SafeId<"entity">;
    entityName: string;
    fieldId: SafeId<"field">;
    fileName: string;
    mimeType: string;
    pdfFileId: string | null;
    propertyId: SafeId<"property">;
  };
} | null> => {
  const rows = await scopedDb((tx) =>
    tx
      .select({
        content: fields.content,
        entityName: entities.name,
        entityVersionId: entityVersions.id,
        propertyId: fields.propertyId,
      })
      .from(entities)
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, entities.currentVersionId),
          isNull(entityVersions.deletedAt),
        ),
      )
      .innerJoin(
        fields,
        and(
          eq(fields.entityVersionId, entityVersions.id),
          eq(fields.id, fieldId),
        ),
      )
      .where(
        and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
      )
      .limit(1),
  );
  const current = rows.at(0);
  if (!current || current.content.type !== "file") {
    return null;
  }
  const source = {
    entityId,
    entityVersionId: current.entityVersionId,
    fieldId,
    fileId: current.content.id,
    fileName: current.content.fileName,
    mimeType: current.content.mimeType,
    sha256Hex: current.content.sha256Hex,
  };
  if (!resolveOfficeEvidenceFormat(source.mimeType)) {
    return null;
  }
  const evidenceRows = await readEvidenceRows(
    scopedDb,
    { organizationId, workspaceId },
    source,
  );
  const evidenceRow = evidenceRows.at(0);
  if (!evidenceRow) {
    return null;
  }
  const payload = await decodeEvidenceRow(evidenceRow, organizationId);
  const block = payload?.blocks.find(({ id }) => id === blockId);
  if (!block) {
    return null;
  }
  return {
    block,
    source: {
      entityId,
      entityName: current.entityName,
      fieldId,
      fileName: current.content.fileName,
      mimeType: current.content.mimeType,
      pdfFileId: current.content.pdfFileId,
      propertyId: current.propertyId,
    },
  };
};
