import { Result } from "better-result";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import {
  corpusMirrorColumns,
  corpusPayloadDisposition,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  CorpusPayload,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";
import type { StoredRawResultReader } from "@/api/lib/legal-search/ingestion-types";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

import { writeOwnedRawPayload } from "./retained-raw";
import { SourceInputError } from "./source-input";
import { readStoredRawFromS3 } from "./stored-raw";
import { assessRawPayload } from "./validation";
import { writeRetentionVerdictTx } from "./verdict-storage";

export type DeferredRawStorage = {
  readRaw: StoredRawResultReader;
  writeRaw: typeof writeOwnedRawPayload;
};
const DEFAULT_RAW_STORAGE: DeferredRawStorage = {
  readRaw: readStoredRawFromS3,
  writeRaw: writeOwnedRawPayload,
};

/** Legacy SK rows wrapped two responses; keep each in its original story part. */
const deferredSourceEnvelope = (bytes: Uint8Array | null): string => {
  if (bytes === null) {
    return encodeSourceRawEnvelope({});
  }
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (decoded.isErr()) {
    throw new SourceInputError({
      message: "Stored SK listing is not UTF-8",
      reason: "malformed",
      cause: decoded.error,
    });
  }
  const text = decoded.value;
  if (decodeSourceRawEnvelope(text) !== null) {
    return text;
  }
  const parsed = Result.try((): unknown => JSON.parse(text));
  if (
    parsed.isErr() ||
    !isRecord(parsed.value) ||
    "version" in parsed.value ||
    !isRecord(parsed.value["listItem"])
  ) {
    throw new SourceInputError({
      message: "Stored SK listing has an unsupported raw shape",
      reason: "malformed",
    });
  }
  const detail = parsed.value["detail"];
  if (detail !== undefined && detail !== null && !isRecord(detail)) {
    throw new SourceInputError({
      message: "Stored SK detail is malformed",
      reason: "malformed",
    });
  }
  return encodeSourceRawEnvelope({
    listing: JSON.stringify(parsed.value["listItem"]),
    ...(isRecord(detail) ? { detail: JSON.stringify(detail) } : {}),
  });
};

const VALIDATED_DEFERRED = Symbol("validated deferred payload");

type PrepareDeferredDocumentOptions = {
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  payload: CorpusPayload;
  rawBytes: Uint8Array | undefined;
  rawStorage?: DeferredRawStorage;
};

/** Preserve the listing envelope and retain the downloaded PDF before promotion. */
export const prepareDeferredDocument = async ({
  decisionId,
  scopedDb,
  payload,
  rawBytes,
  rawStorage = DEFAULT_RAW_STORAGE,
}: PrepareDeferredDocumentOptions) => {
  const window = openRawSourceWriteWindow();
  const row = (
    await scopedDb((tx) =>
      tx
        .select({
          sourceId: caseLawDecisions.sourceId,
          sourceHash: caseLawDecisions.sourceHash,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          sourceRawContentType: caseLawDecisions.sourceRawContentType,
          redactedAt: caseLawDecisions.redactedAt,
          caseNumber: caseLawDecisions.caseNumber,
          court: caseLawDecisions.court,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .limit(1),
    )
  ).at(0);
  if (row === undefined || row.redactedAt !== null) {
    return null;
  }
  let preparedRaw = null;
  if (rawBytes !== undefined) {
    const old =
      row.sourceRawS3Key === null
        ? Result.ok(null)
        : await rawStorage.readRaw(row.sourceRawS3Key);
    if (old.isErr()) {
      throw old.error;
    }
    if (row.sourceRawS3Key !== null && old.value === null) {
      throw new SourceInputError({
        message: "Stored SK raw pointer names a missing payload",
        reason: "unavailable",
      });
    }
    if (old.value !== null && row.sourceRawS3Key !== null) {
      const namedDigest = row.sourceRawS3Key.slice(
        row.sourceRawS3Key.lastIndexOf("/") + 1,
      );
      const actualDigest = new Bun.CryptoHasher("sha256")
        .update(old.value)
        .digest("hex");
      if (/^[0-9a-f]{64}$/u.test(namedDigest) && actualDigest !== namedDigest) {
        throw new SourceInputError({
          message: "Stored SK listing does not match its raw pointer",
          reason: "malformed",
        });
      }
    }
    const sourceRaw = deferredSourceEnvelope(old.value);
    const written = await rawStorage.writeRaw({
      result: {
        caseNumber: row.caseNumber,
        court: row.court,
        country: "SVK",
        language: "sk",
        metadata: {},
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        rawHash: "",
        sourceRaw,
        sourceRawObjects: {
          "document-file": { bytes: rawBytes, contentType: "application/pdf" },
        },
      },
      sourceId: row.sourceId,
      ownerId: decisionId,
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      storedKey: row.sourceRawS3Key,
      storedContentType: row.sourceRawContentType,
      window,
    });
    if (written.isErr()) {
      throw written.error;
    }
    preparedRaw = written.value ?? null;
  }
  const assessment = await assessRawPayload({
    source:
      preparedRaw === null
        ? null
        : {
            raw: preparedRaw.payload,
            contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
            sourceKey: ADAPTER_KEYS.SK_COURTS,
            binaryCache: preparedRaw.binaryCache,
          },
    payload,
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
  });
  return {
    [VALIDATED_DEFERRED]: true as const,
    payload,
    assessment,
    preparedRaw,
    sourceId: row.sourceId,
    snapshot: row,
  };
};

type ApplyDeferredDocumentOptions = {
  decisionId: SafeId<"caseLawDecision">;
  validation: NonNullable<Awaited<ReturnType<typeof prepareDeferredDocument>>>;
  ownerPredicate: SQL;
  mode: CorpusStorageMode;
  written: WriteCorpusResult | null;
};

export const applyDeferredDocumentTx = async (
  tx: Transaction,
  {
    decisionId,
    validation,
    ownerPredicate,
    mode,
    written,
  }: ApplyDeferredDocumentOptions,
) => {
  const { payload, preparedRaw } = validation;
  const payloadColumns =
    corpusPayloadDisposition({ mode, written }) === "trim"
      ? TRIMMED_CORPUS_PAYLOAD_COLUMNS
      : {
          fulltext: payload.text,
          documentAst: payload.ast,
          sections: payload.sections,
        };
  // audit: skip — background case-law ingestion; public case-law data
  const applied = await tx
    .update(caseLawDecisions)
    .set({
      ...payloadColumns,
      ...(preparedRaw === null
        ? {}
        : {
            sourceRawS3Key: preparedRaw.key,
            sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
          }),
      parserVersion: validation.assessment.parserVersion,
      ...corpusMirrorColumns({
        status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        written,
      }),
    })
    .where(
      and(
        ownerPredicate,
        eq(caseLawDecisions.id, decisionId),
        isNull(caseLawDecisions.redactedAt),
        eq(caseLawDecisions.sourceId, validation.snapshot.sourceId),
        sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${validation.snapshot.sourceHash}`,
        sql`${caseLawDecisions.sourceRawS3Key} IS NOT DISTINCT FROM ${validation.snapshot.sourceRawS3Key}`,
        sql`${caseLawDecisions.sourceRawContentType} IS NOT DISTINCT FROM ${validation.snapshot.sourceRawContentType}`,
      ),
    )
    .returning({ id: caseLawDecisions.id });
  if (applied.length > 0) {
    await writeRetentionVerdictTx(tx, {
      decisionId,
      sourceId: validation.sourceId,
      sourceHash: validation.snapshot.sourceHash,
      rawS3Key: preparedRaw?.key ?? validation.snapshot.sourceRawS3Key,
      assessment: validation.assessment,
    });
  }
  const { assessment } = validation;
  const { verdict } = assessment;
  if (
    applied.length > 0 &&
    (verdict.status === "unavailable" ||
      (verdict.status === "assessed" && verdict.defect !== null))
  ) {
    logger.warn("case_law.ingestion.text_retention", {
      decisionId,
      sourceId: validation.sourceId,
      parserVersion: assessment.parserVersion,
      oracleVersion: assessment.oracleVersion,
      exclusionVersion: assessment.exclusionVersion,
      ...(assessment.rawFingerprint === null
        ? {}
        : { rawFingerprint: assessment.rawFingerprint }),
      payloadFingerprint: assessment.payloadFingerprint,
      ...(verdict.status === "unavailable"
        ? { status: verdict.status, reason: verdict.reason }
        : {
            status: verdict.status,
            ...(verdict.defect === null ? {} : { defect: verdict.defect }),
            retainedRatio: verdict.retainedRatio,
            missingWords: verdict.missingWords,
            missingCharacters: verdict.missingCharacters,
            ...(verdict.missingSampleHash === null
              ? {}
              : { missingSampleHash: verdict.missingSampleHash }),
          }),
    });
  }
  return applied;
};
