import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import { DOCUMENT_SUPPLEMENTS_METADATA_KEY } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@/api/lib/legal-search/ingestion-constants";
import type { StoredRawResultReader } from "@/api/lib/legal-search/ingestion-types";
import { readStoredRawFromS3 } from "@/api/lib/legal-search/text-retention/stored-raw";
import {
  assessRawPayload,
  type AssessmentReason,
  type PayloadAssessment,
} from "@/api/lib/legal-search/text-retention/validation";
import { logger } from "@/api/lib/observability/logger";

import type { IngestionResult } from "../adapter";
import { caseLawCanonicalPayload } from "./corpus-mirror";
import type { DecisionWritePlan } from "./decision-plan";
import type { SourceRawArtifact } from "./decision-raw";
import type { CaseLawCorpusDependencies } from "./dependencies";
import type { RetainedSupplementRaw } from "./supplement-raw-retention";
import { loadValidationSnapshot } from "./validation-snapshot";

export const sourceKeyOf = (key: string) =>
  [...Object.values(ADAPTER_KEYS), ...Object.values(IMPORT_SOURCE_KEYS)].find(
    (candidate) => candidate === key,
  );

export const readValidationBinary = async (
  location: string,
  readRaw = readStoredRawFromS3,
) => {
  const read = await readRaw(location);
  if (read.isErr()) {
    captureError(read.error, { step: "readValidationBinary" });
    throw read.error;
  }
  return read.value;
};

type ResolveValidationSourceOptions = {
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  sourceKey?: string | undefined;
};

export const resolveValidationSourceKey = async ({
  sourceId,
  scopedDb,
  sourceKey,
}: ResolveValidationSourceOptions) => {
  if (sourceKey !== undefined) {
    return sourceKeyOf(sourceKey);
  }
  const row = (
    await scopedDb((tx) =>
      tx
        .select({ key: caseLawSources.adapterKey })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
        .limit(1),
    )
  ).at(0);
  return row === undefined ? undefined : sourceKeyOf(row.key);
};

type LogRetentionAssessmentOptions = {
  assessment: PayloadAssessment;
  decisionId: SafeId<"caseLawDecision">;
  sourceId?: SafeId<"caseLawSource"> | undefined;
};

/** Telemetry carries metrics and hashes, never source text or missing excerpts. */
export const logRetentionAssessment = ({
  assessment,
  decisionId,
  sourceId,
}: LogRetentionAssessmentOptions) => {
  const subject = {
    decisionId,
    ...(sourceId === undefined ? {} : { sourceId }),
    parserVersion: assessment.parserVersion,
    oracleVersion: assessment.oracleVersion,
    exclusionVersion: assessment.exclusionVersion,
    payloadFingerprint: assessment.payloadFingerprint,
    ...(assessment.rawFingerprint === null
      ? {}
      : { rawFingerprint: assessment.rawFingerprint }),
  };
  const { verdict } = assessment;
  switch (verdict.status) {
    case "unavailable":
      logger.warn("case_law.ingestion.text_retention", {
        ...subject,
        status: verdict.status,
        reason: verdict.reason,
      });
      return;
    case "assessed":
      if (verdict.defect !== null) {
        logger.warn("case_law.ingestion.text_retention", {
          ...subject,
          status: verdict.status,
          defect: verdict.defect,
          retainedRatio: verdict.retainedRatio,
          missingWords: verdict.missingWords,
          missingCharacters: verdict.missingCharacters,
          ...(verdict.missingSampleHash === null
            ? {}
            : { missingSampleHash: verdict.missingSampleHash }),
        });
      }
      return;
    case "empty_source":
      return;
    default:
      verdict satisfies never;
      return panic("Unhandled retention assessment status");
  }
};

type AssessStoredDecisionOptions = {
  scopedDb: ScopedDb;
  decisionId: SafeId<"caseLawDecision">;
  sourceId?: SafeId<"caseLawSource"> | undefined;
  sourceKey: ReturnType<typeof sourceKeyOf>;
  rawArtifact?: SourceRawArtifact;
  readBytes?: CaseLawCorpusDependencies["readBytes"];
  readStoredRaw?: StoredRawResultReader;
};

type StoredDecisionAssessment = {
  snapshot: Awaited<ReturnType<typeof loadValidationSnapshot>>;
  assessment: PayloadAssessment;
};

/** Assess exactly the snapshot a validation-only CAS will later fence. */
export const assessStoredDecision = async ({
  scopedDb,
  decisionId,
  sourceId,
  sourceKey,
  rawArtifact,
  readBytes,
  readStoredRaw = readStoredRawFromS3,
}: AssessStoredDecisionOptions): Promise<StoredDecisionAssessment> => {
  const loaded = await Result.tryPromise(() =>
    loadValidationSnapshot({ scopedDb, decisionId, readBytes }),
  );
  if (loaded.isErr()) {
    captureError(loaded.error, {
      decisionId,
      step: "assessStoredDecision.readPayload",
    });
  }
  const snapshot = loaded.isErr() ? null : loaded.value;
  const payload =
    snapshot === null
      ? { text: null, ast: null, sections: null }
      : snapshot.payload;
  const unavailable = async (
    reason: AssessmentReason,
  ): Promise<StoredDecisionAssessment> => {
    const unavailableAssessment = await assessRawPayload({
      source: null,
      payload,
      parserVersion: snapshot?.row.parserVersion ?? 0,
    });
    const assessment = {
      ...unavailableAssessment,
      verdict: { status: "unavailable", reason } as const,
    };
    logRetentionAssessment({
      assessment,
      decisionId,
      sourceId: sourceId ?? snapshot?.row.sourceId,
    });
    return { snapshot, assessment };
  };
  if (loaded.isErr()) {
    return await unavailable("payload_read_failed");
  }
  if (snapshot === null) {
    return await unavailable("missing_snapshot");
  }
  if (sourceId !== undefined && snapshot.row.sourceId !== sourceId) {
    return await unavailable("source_mismatch");
  }
  const composed = snapshot.row.metadata?.[DOCUMENT_SUPPLEMENTS_METADATA_KEY];
  if (
    composed !== undefined &&
    (!Array.isArray(composed) || composed.length > 0)
  ) {
    // Final occurrence counts alone cannot show which component lost text;
    // stored historical compositions need their original component evidence.
    return await unavailable("composite_unreverifiable");
  }
  if (sourceKey === undefined) {
    return await unavailable("unknown_source");
  }
  const storedKey = snapshot.row.sourceRawS3Key;
  if (storedKey === null) {
    return await unavailable("no_raw");
  }
  const preparedRaw = rawArtifact?.preparedRaw;
  const exactPreparedRaw =
    preparedRaw !== null &&
    preparedRaw !== undefined &&
    preparedRaw.key === storedKey
      ? preparedRaw
      : null;
  const read =
    exactPreparedRaw === null
      ? await readStoredRaw(storedKey)
      : Result.ok(exactPreparedRaw.payload);
  if (read.isErr()) {
    captureError(read.error, {
      decisionId,
      step: "assessStoredDecision.readRaw",
    });
    return await unavailable("raw_read_failed");
  }
  if (read.value === null) {
    return await unavailable("no_raw");
  }
  const rawDigest = new Bun.CryptoHasher("sha256")
    .update(read.value)
    .digest("hex");
  const namedDigest = storedKey.slice(storedKey.lastIndexOf("/") + 1);
  if (/^[0-9a-f]{64}$/u.test(namedDigest) && namedDigest !== rawDigest) {
    return await unavailable("raw_mismatch");
  }
  const assessment = await assessRawPayload({
    source: {
      raw: read.value,
      contentType: snapshot.row.sourceRawContentType,
      sourceKey,
      ...(exactPreparedRaw === null
        ? {}
        : { binaryCache: exactPreparedRaw.binaryCache }),
      readBinary: async (location) =>
        await readValidationBinary(location, readStoredRaw),
    },
    payload,
    parserVersion: snapshot.row.parserVersion ?? 0,
  });
  if (
    snapshot.row.contentHash !== null &&
    snapshot.row.contentHash !== assessment.payloadFingerprint
  ) {
    return await unavailable("payload_mismatch");
  }
  logRetentionAssessment({
    assessment,
    decisionId,
    sourceId: snapshot.row.sourceId,
  });
  return { snapshot, assessment };
};

const VALIDATED_PAYLOAD = Symbol("validated case-law payload");

export type ValidatedDecisionPlan = DecisionWritePlan & {
  readonly [VALIDATED_PAYLOAD]: true;
  assessment: Awaited<ReturnType<typeof assessRawPayload>>;
};

type ValidateDecisionPlanOptions = {
  scopedDb: ScopedDb;
  decisionId: SafeId<"caseLawDecision">;
  readBytes?: CaseLawCorpusDependencies["readBytes"];
  plan: DecisionWritePlan;
  rawArtifact: SourceRawArtifact;
  sourceKey: ReturnType<typeof sourceKeyOf>;
  judgment: IngestionResult;
  retainedSupplements: RetainedSupplementRaw;
};

/** Constructed only after pending-payload selection and citation annotations. */
export const validateDecisionPlan = async ({
  scopedDb,
  decisionId,
  readBytes,
  plan,
  rawArtifact,
  sourceKey,
  judgment,
  retainedSupplements,
}: ValidateDecisionPlanOptions): Promise<ValidatedDecisionPlan> => {
  if (plan.corpusPlan.type === "preserve-stored") {
    const { snapshot, assessment } = await assessStoredDecision({
      scopedDb,
      decisionId,
      sourceKey,
      rawArtifact,
      readBytes,
    });
    return {
      ...plan,
      corpusPayload:
        snapshot === null
          ? {
              documentId: decisionId,
              jurisdiction: plan.corpusPayload.jurisdiction,
              text: null,
              ast: null,
              sections: null,
            }
          : {
              documentId: decisionId,
              jurisdiction: snapshot.row.country,
              ...snapshot.payload,
            },
      assessment,
      [VALIDATED_PAYLOAD]: true,
    };
  }
  const raw = rawArtifact.preparedRaw;
  const source =
    raw === null || sourceKey === undefined
      ? null
      : {
          raw: raw.payload,
          contentType: rawArtifact.sourceRawContentType,
          sourceKey,
          binaryCache: raw.binaryCache,
          readBinary: readValidationBinary,
        };
  const components =
    retainedSupplements.length === 0
      ? []
      : [
          {
            id: "judgment",
            source,
            payload: caseLawCanonicalPayload(judgment),
          },
          ...retainedSupplements.map(({ supplement, preparedRaw }) => ({
            id: supplement.sourceDocumentId,
            source:
              preparedRaw === null || sourceKey === undefined
                ? null
                : {
                    raw: preparedRaw.payload,
                    contentType: supplement.sourceRawContentType ?? null,
                    sourceKey,
                    binaryCache: preparedRaw.binaryCache,
                    readBinary: readValidationBinary,
                  },
            payload: {
              text: supplement.fulltext,
              ast: supplement.documentAst,
              sections: null,
            },
          })),
        ];
  const assessment = await assessRawPayload({
    source,
    components,
    payload: plan.corpusPayload,
    parserVersion: plan.preparedResult.parserVersion ?? 0,
  });
  return { ...plan, assessment, [VALIDATED_PAYLOAD]: true };
};
