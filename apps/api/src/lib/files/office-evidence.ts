import { panic, Result } from "better-result";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
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
import { createOfficeEvidenceAdmission } from "@/api/lib/files/office-evidence-admission";
import {
  OFFICE_EVIDENCE_LIMITS,
  OFFICE_EVIDENCE_STATUS,
  type OfficeEvidenceStatus,
} from "@/api/lib/files/office-evidence-domain";
import {
  OFFICE_EVIDENCE_FORMAT,
  OFFICE_EVIDENCE_PARSER_VERSION,
  officeEvidencePayloadSchema,
  type OfficeEvidenceBlock,
  type OfficeEvidenceFormat,
  type OfficeEvidencePayload,
} from "@/api/lib/files/office-evidence-types";
import { createFileKey } from "@/api/lib/files/utils";
import { OBJECT_READ_TIMEOUT_MS, readS3ArrayBuffer } from "@/api/lib/s3";
import { normalizeMimeType } from "@/api/lib/search/extractable-mime-types";
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
  claimExpiresAt: Date | null;
  claimToken: string | null;
  errorCode: string | null;
  format: OfficeEvidenceFormat;
  payloadCiphertext: Buffer | null;
  payloadIv: Buffer | null;
  status: OfficeEvidenceStatus;
};

const OFFICE_EVIDENCE_FINALIZATION_GRACE_MS = 60_000;
const OFFICE_EVIDENCE_CLAIM_MS =
  OBJECT_READ_TIMEOUT_MS +
  OFFICE_EVIDENCE_LIMITS.workerTimeoutMs +
  OFFICE_EVIDENCE_FINALIZATION_GRACE_MS;
const officeEvidenceAdmission = createOfficeEvidenceAdmission(1);

const evidenceRowSelection = {
  blockCount: officeFileEvidence.blockCount,
  claimExpiresAt: officeFileEvidence.claimExpiresAt,
  claimToken: officeFileEvidence.claimToken,
  errorCode: officeFileEvidence.errorCode,
  format: officeFileEvidence.format,
  payloadCiphertext: officeFileEvidence.payloadCiphertext,
  payloadIv: officeFileEvidence.payloadIv,
  status: officeFileEvidence.status,
};

export const resolveOfficeEvidenceFormat = (
  mimeType: string,
): OfficeEvidenceFormat | null => {
  const normalized = normalizeMimeType(mimeType);
  if (normalized === XLSX_MIME_TYPE) {
    return OFFICE_EVIDENCE_FORMAT.xlsx;
  }
  return normalized === PPTX_MIME_TYPE ? OFFICE_EVIDENCE_FORMAT.pptx : null;
};

const evidenceSourceIdentityWhere = (
  scope: OfficeEvidenceScope,
  source: OfficeEvidenceSource,
) =>
  and(
    eq(officeFileEvidence.organizationId, scope.organizationId),
    eq(officeFileEvidence.workspaceId, scope.workspaceId),
    eq(officeFileEvidence.entityVersionId, source.entityVersionId),
    eq(officeFileEvidence.fieldId, source.fieldId),
    eq(officeFileEvidence.sourceFileId, source.fileId),
    eq(officeFileEvidence.sourceSha256Hex, source.sha256Hex),
  );

const evidenceSourceWhere = (
  scope: OfficeEvidenceScope,
  source: OfficeEvidenceSource,
) =>
  and(
    evidenceSourceIdentityWhere(scope, source),
    eq(officeFileEvidence.parserVersion, OFFICE_EVIDENCE_PARSER_VERSION),
  );

const selectEvidenceRows = async (
  tx: Transaction,
  scope: OfficeEvidenceScope,
  source: OfficeEvidenceSource,
) =>
  await tx
    .select(evidenceRowSelection)
    .from(officeFileEvidence)
    .where(evidenceSourceWhere(scope, source))
    .limit(1);

const selectEvidenceVersionRows = async (
  tx: Transaction,
  scope: OfficeEvidenceScope,
  source: OfficeEvidenceSource,
) =>
  await tx
    .select(evidenceRowSelection)
    .from(officeFileEvidence)
    .where(
      and(
        evidenceSourceIdentityWhere(scope, source),
        eq(officeFileEvidence.status, OFFICE_EVIDENCE_STATUS.available),
      ),
    )
    .orderBy(desc(officeFileEvidence.parserVersion))
    .limit(OFFICE_EVIDENCE_LIMITS.verificationParserVersionsMax);

const parseJson = (value: string): unknown => JSON.parse(value);

const decodeEvidenceRow = async (
  row: PersistedEvidenceRow,
  organizationId: SafeId<"organization">,
): Promise<OfficeEvidencePayload | null> => {
  const { payloadCiphertext, payloadIv } = row;
  if (
    row.status !== OFFICE_EVIDENCE_STATUS.available ||
    !payloadCiphertext ||
    !payloadIv
  ) {
    return null;
  }

  const decryptResult = await Result.tryPromise({
    try: async () =>
      await decryptContent(organizationId, payloadCiphertext, payloadIv),
    catch: (cause) => cause,
  });
  if (Result.isError(decryptResult)) {
    captureError(decryptResult.error, { operation: "office-evidence-decrypt" });
    return null;
  }
  const jsonResult = Result.try({
    try: () => parseJson(decryptResult.value),
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

type FindEvidenceBlockOptions = {
  blockId: string;
  evidenceRows: readonly PersistedEvidenceRow[];
  index?: number;
  organizationId: SafeId<"organization">;
};

const findEvidenceBlock = async ({
  blockId,
  evidenceRows,
  index = 0,
  organizationId,
}: FindEvidenceBlockOptions): Promise<OfficeEvidenceBlock | null> => {
  const evidenceRow = evidenceRows.at(index);
  if (!evidenceRow) {
    return null;
  }
  const payload = await decodeEvidenceRow(evidenceRow, organizationId);
  const block = payload?.blocks.find(({ id }) => id === blockId);
  return (
    block ??
    findEvidenceBlock({
      blockId,
      evidenceRows,
      index: index + 1,
      organizationId,
    })
  );
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

type OfficeEvidenceClaim =
  | { type: "cached"; row: PersistedEvidenceRow }
  | { type: "claimed"; claimToken: string }
  | { type: "pending" };

type ClaimOfficeEvidenceOptions = OfficeEvidenceScope & {
  format: OfficeEvidenceFormat;
  safeDb: SafeDb;
  source: OfficeEvidenceSource;
};

const claimOfficeEvidence = async ({
  format,
  organizationId,
  safeDb,
  source,
  workspaceId,
}: ClaimOfficeEvidenceOptions) => {
  const scope = { organizationId, workspaceId };
  return await safeDb(async (tx): Promise<OfficeEvidenceClaim> => {
    if (!(await isCurrentSource(tx, scope, source))) {
      return { type: "pending" };
    }

    const claimToken = Bun.randomUUIDv7();
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + OFFICE_EVIDENCE_CLAIM_MS);
    const inserted = await tx
      .insert(officeFileEvidence)
      .values({
        blockCount: 0,
        claimExpiresAt,
        claimToken,
        entityId: source.entityId,
        entityVersionId: source.entityVersionId,
        errorCode: null,
        fieldId: source.fieldId,
        format,
        organizationId,
        parserVersion: OFFICE_EVIDENCE_PARSER_VERSION,
        payloadCiphertext: null,
        payloadIv: null,
        sourceFileId: source.fileId,
        sourceSha256Hex: source.sha256Hex,
        status: OFFICE_EVIDENCE_STATUS.processing,
        workspaceId,
      })
      .onConflictDoNothing()
      .returning({ claimToken: officeFileEvidence.claimToken });
    if (inserted.length === 1) {
      return { claimToken, type: "claimed" };
    }

    const existing = (await selectEvidenceRows(tx, scope, source)).at(0);
    if (!existing) {
      return { type: "pending" };
    }
    if (existing.status !== OFFICE_EVIDENCE_STATUS.processing) {
      return { row: existing, type: "cached" };
    }
    if (
      !existing.claimToken ||
      !existing.claimExpiresAt ||
      existing.claimExpiresAt > now
    ) {
      return { type: "pending" };
    }

    const reclaimed = await tx
      .update(officeFileEvidence)
      .set({ claimExpiresAt, claimToken })
      .where(
        and(
          evidenceSourceWhere(scope, source),
          eq(officeFileEvidence.status, OFFICE_EVIDENCE_STATUS.processing),
          eq(officeFileEvidence.claimToken, existing.claimToken),
          lte(officeFileEvidence.claimExpiresAt, now),
        ),
      )
      .returning({ claimToken: officeFileEvidence.claimToken });
    return reclaimed.length === 1
      ? { claimToken, type: "claimed" }
      : { type: "pending" };
  });
};

type AbandonOfficeEvidenceClaimOptions = OfficeEvidenceScope & {
  claimToken: string;
  safeDb: SafeDb;
  source: OfficeEvidenceSource;
};

const abandonOfficeEvidenceClaim = async ({
  claimToken,
  organizationId,
  safeDb,
  source,
  workspaceId,
}: AbandonOfficeEvidenceClaimOptions) =>
  await safeDb(async (tx) => {
    await tx
      .delete(officeFileEvidence)
      .where(
        and(
          evidenceSourceWhere({ organizationId, workspaceId }, source),
          eq(officeFileEvidence.status, OFFICE_EVIDENCE_STATUS.processing),
          eq(officeFileEvidence.claimToken, claimToken),
        ),
      );
  });

type CaptureAndAbandonOfficeEvidenceOptions =
  AbandonOfficeEvidenceClaimOptions & {
    error: unknown;
    operation: string;
  };

const captureAndAbandonOfficeEvidence = async ({
  error,
  operation,
  ...claim
}: CaptureAndAbandonOfficeEvidenceOptions): Promise<null> => {
  captureError(error, { operation });
  const abandoned = await abandonOfficeEvidenceClaim(claim);
  if (Result.isError(abandoned)) {
    captureError(abandoned.error, { operation: "office-evidence-abandon" });
  }
  return null;
};

type CreateClaimedOfficeEvidenceOptions = ClaimOfficeEvidenceOptions & {
  claimToken: string;
};

const createClaimedOfficeEvidence = async ({
  claimToken,
  format,
  organizationId,
  safeDb,
  source,
  workspaceId,
}: CreateClaimedOfficeEvidenceOptions): Promise<OfficeEvidencePayload | null> => {
  const claim = {
    claimToken,
    organizationId,
    safeDb,
    source,
    workspaceId,
  };
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
    return await captureAndAbandonOfficeEvidence({
      ...claim,
      error: readResult.error,
      operation: "office-evidence-file-read",
    });
  }

  const extraction = await extractOfficeEvidence(readResult.value, format);
  if (Result.isError(extraction)) {
    return await captureAndAbandonOfficeEvidence({
      ...claim,
      error: extraction.error,
      operation: "office-evidence-extract",
    });
  }

  const extractionValue = extraction.value;
  const encryptedResult =
    extractionValue.status === OFFICE_EVIDENCE_STATUS.available
      ? await Result.tryPromise({
          try: async () =>
            await encryptContent(
              organizationId,
              JSON.stringify(extractionValue.payload),
            ),
          catch: (cause) => cause,
        })
      : Result.ok(null);
  if (Result.isError(encryptedResult)) {
    return await captureAndAbandonOfficeEvidence({
      ...claim,
      error: encryptedResult.error,
      operation: "office-evidence-encrypt",
    });
  }
  const scope = { organizationId, workspaceId };
  const persistResult = await safeDb(async (tx) => {
    if (!(await isCurrentSource(tx, scope, source))) {
      await tx
        .delete(officeFileEvidence)
        .where(
          and(
            evidenceSourceWhere(scope, source),
            eq(officeFileEvidence.claimToken, claimToken),
          ),
        );
      return null;
    }

    const value = extractionValue;
    const terminalValues = (() => {
      if (value.status === OFFICE_EVIDENCE_STATUS.unavailable) {
        return {
          blockCount: 0,
          claimExpiresAt: null,
          claimToken: null,
          errorCode: value.errorCode,
          payloadCiphertext: null,
          payloadIv: null,
          status: OFFICE_EVIDENCE_STATUS.unavailable,
        };
      }
      const encrypted = encryptedResult.value;
      if (!encrypted) {
        panic("Available Office evidence must be encrypted before persistence");
      }
      return {
        blockCount: value.payload.blocks.length,
        claimExpiresAt: null,
        claimToken: null,
        errorCode: null,
        payloadCiphertext: encrypted.ciphertext,
        payloadIv: encrypted.iv,
        status: OFFICE_EVIDENCE_STATUS.available,
      };
    })();
    const updated = await tx
      .update(officeFileEvidence)
      .set(terminalValues)
      .where(
        and(
          evidenceSourceWhere(scope, source),
          eq(officeFileEvidence.status, OFFICE_EVIDENCE_STATUS.processing),
          eq(officeFileEvidence.claimToken, claimToken),
        ),
      )
      .returning(evidenceRowSelection);
    return updated.at(0) ?? null;
  });
  if (Result.isError(persistResult)) {
    return await captureAndAbandonOfficeEvidence({
      ...claim,
      error: persistResult.error,
      operation: "office-evidence-persist",
    });
  }
  return persistResult.value
    ? await decodeEvidenceRow(persistResult.value, organizationId)
    : null;
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
  const claimResult = await claimOfficeEvidence({
    format,
    organizationId,
    safeDb,
    source,
    workspaceId,
  });
  if (Result.isError(claimResult)) {
    captureError(claimResult.error, { operation: "office-evidence-claim" });
    return null;
  }
  const claim = claimResult.value;
  if (claim.type === "cached") {
    return await decodeEvidenceRow(claim.row, organizationId);
  }
  if (claim.type === "pending") {
    return null;
  }

  const releaseAdmission = officeEvidenceAdmission.tryAcquire();
  if (!releaseAdmission) {
    const abandoned = await abandonOfficeEvidenceClaim({
      claimToken: claim.claimToken,
      organizationId,
      safeDb,
      source,
      workspaceId,
    });
    if (Result.isError(abandoned)) {
      captureError(abandoned.error, { operation: "office-evidence-abandon" });
    }
    return null;
  }
  return await createClaimedOfficeEvidence({
    claimToken: claim.claimToken,
    format,
    organizationId,
    safeDb,
    source,
    workspaceId,
  }).finally(releaseAdmission);
};

type FindOfficeEvidenceBlockOptions = OfficeEvidenceScope & {
  blockId: string;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  scopedDb: ScopedDb;
};

export const findOfficeEvidenceBlock = async ({
  blockId,
  entityId,
  fieldId,
  organizationId,
  scopedDb,
  workspaceId,
}: FindOfficeEvidenceBlockOptions): Promise<{
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
  const resolved = await scopedDb(async (tx) => {
    const rows = await tx
      .select({
        content: fields.content,
        entityName: entities.name,
        entityVersionId: entityVersions.id,
        propertyId: fields.propertyId,
      })
      .from(fields)
      .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
      .innerJoin(
        entities,
        and(
          eq(entityVersions.entityId, entities.id),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(fields.id, fieldId),
          eq(fields.workspaceId, workspaceId),
          eq(entityVersions.workspaceId, workspaceId),
          eq(entities.id, entityId),
          isNull(entityVersions.deletedAt),
        ),
      )
      .limit(1);
    const fieldSource = rows.at(0);
    if (!fieldSource || fieldSource.content.type !== "file") {
      return null;
    }
    const source = {
      entityId,
      entityVersionId: fieldSource.entityVersionId,
      fieldId,
      fileId: fieldSource.content.id,
      fileName: fieldSource.content.fileName,
      mimeType: fieldSource.content.mimeType,
      sha256Hex: fieldSource.content.sha256Hex,
    };
    if (!resolveOfficeEvidenceFormat(source.mimeType)) {
      return null;
    }
    const evidenceRows = await selectEvidenceVersionRows(
      tx,
      { organizationId, workspaceId },
      source,
    );
    return evidenceRows.length > 0
      ? {
          evidenceRows,
          source: {
            entityId,
            entityName: fieldSource.entityName,
            fieldId,
            fileName: fieldSource.content.fileName,
            mimeType: fieldSource.content.mimeType,
            pdfFileId: fieldSource.content.pdfFileId,
            propertyId: fieldSource.propertyId,
          },
        }
      : null;
  });
  if (!resolved) {
    return null;
  }
  const { evidenceRows, source } = resolved;
  const block = await findEvidenceBlock({
    blockId,
    evidenceRows,
    organizationId,
  });
  return block ? { block, source } : null;
};
