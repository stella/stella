import { panic, Result } from "better-result";

import { sha256Hex } from "@stll/sha256/bun";

import type { RejectedCaseLawIngestionRecord } from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import type {
  DecisionSupplement,
  IngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import { sortDeep } from "@/api/lib/sort-deep";

const INGESTION_FAILURE_IDENTITY_KIND = {
  SOURCE_DOCUMENT: "source-document",
  PROVIDED_RECORD: "provided-record",
  CAPTURED_INPUT: "captured-input",
} as const;

export type IngestionFailureIdentityKind =
  (typeof INGESTION_FAILURE_IDENTITY_KIND)[keyof typeof INGESTION_FAILURE_IDENTITY_KIND];

export const INGESTION_FAILURE_IDENTITY_KINDS = [
  INGESTION_FAILURE_IDENTITY_KIND.SOURCE_DOCUMENT,
  INGESTION_FAILURE_IDENTITY_KIND.PROVIDED_RECORD,
  INGESTION_FAILURE_IDENTITY_KIND.CAPTURED_INPUT,
] as const satisfies readonly IngestionFailureIdentityKind[];

const validFailureIdentity = (value: string | undefined): value is string =>
  value !== undefined &&
  value.length > 0 &&
  value.length <= 256 &&
  !value.includes("\u0000");

/** The admitted input, including publisher bytes, without a decision owner. */
export type IngestionFailureEvidence = {
  payload: string;
  payloadHash: string;
  sourceDocumentId: string | null;
  observationOrder: bigint;
  observedAt: Date;
};

const FAILURE_EVIDENCE_VERSION = 1;

/** One canonical format and digest for captured inputs and withdrawal markers. */
export const encodeIngestionFailureEvidence = (record: unknown) => {
  const payload = JSON.stringify(
    sortDeep({ version: FAILURE_EVIDENCE_VERSION, record }),
  );
  return { payload, payloadHash: sha256Hex(payload) };
};

const capturedDecision = ({
  sourceRawBytes,
  sourceRawObjects,
  plainTextOutcome,
  ...decision
}: IngestionResult) => ({
  ...decision,
  plainTextOutcome:
    plainTextOutcome.type === "accepted"
      ? plainTextOutcome
      : {
          type: plainTextOutcome.type,
          error: {
            message: plainTextOutcome.error.message,
            reason: plainTextOutcome.error.reason,
          },
        },
  ...(sourceRawBytes === undefined
    ? {}
    : { sourceRawBytes: Buffer.from(sourceRawBytes).toString("base64") }),
  ...(sourceRawObjects === undefined
    ? {}
    : {
        sourceRawObjects: Object.fromEntries(
          Object.entries(sourceRawObjects).map(
            ([name, { bytes, contentType }]) => [
              name,
              { bytes: Buffer.from(bytes).toString("base64"), contentType },
            ],
          ),
        ),
      }),
});

type CaptureFailureEvidenceOptions = {
  observation: { order: bigint; observedAt: Date };
  record:
    | { type: "decision"; decision: IngestionResult }
    | { type: "supplement"; supplement: DecisionSupplement }
    | RejectedCaseLawIngestionRecord;
};

/** JSON text preserves escaped NULs; binary fields use explicit base64 encoding. */
export const captureFailureEvidence = ({
  record,
  observation,
}: CaptureFailureEvidenceOptions) =>
  Result.try({
    try: (): IngestionFailureEvidence => {
      const captured = (() => {
        switch (record.type) {
          case "decision":
            return {
              record: {
                type: record.type,
                decision: capturedDecision(record.decision),
              },
              sourceDocumentId: record.decision.sourceDocumentId ?? null,
            };
          case "supplement":
            return {
              record: {
                type: record.type,
                supplement: {
                  ...record.supplement,
                  document: capturedDecision(record.supplement.document),
                },
              },
              sourceDocumentId: record.supplement.document.sourceDocumentId,
            };
          case "rejected":
            return { record, sourceDocumentId: null };
          default:
            record satisfies never;
            return panic("Unhandled failed input record");
        }
      })();
      return {
        ...encodeIngestionFailureEvidence(captured.record),
        sourceDocumentId: validFailureIdentity(
          captured.sourceDocumentId ?? undefined,
        )
          ? captured.sourceDocumentId
          : null,
        observationOrder: observation.order,
        observedAt: observation.observedAt,
      };
    },
    catch: (cause) => cause,
  });

/** Publisher identity is the default; callers may supply an exact import identity. */
type IngestionFailureRecordIdentityOptions = {
  sourceDocumentId: string | undefined;
  recordIdentity?: string | undefined;
  replayEvidence?: IngestionFailureEvidence | undefined;
};

export const ingestionFailureRecordIdentity = ({
  sourceDocumentId,
  recordIdentity,
  replayEvidence,
}: IngestionFailureRecordIdentityOptions):
  | { recordIdentity: string; identityKind: IngestionFailureIdentityKind }
  | undefined => {
  const identityKind = (() => {
    if (recordIdentity !== undefined) {
      return INGESTION_FAILURE_IDENTITY_KIND.PROVIDED_RECORD;
    }
    if (validFailureIdentity(sourceDocumentId)) {
      return INGESTION_FAILURE_IDENTITY_KIND.SOURCE_DOCUMENT;
    }
    return INGESTION_FAILURE_IDENTITY_KIND.CAPTURED_INPUT;
  })();
  const identity =
    recordIdentity ??
    (validFailureIdentity(sourceDocumentId) ? sourceDocumentId : undefined) ??
    (replayEvidence === undefined
      ? undefined
      : `input:${replayEvidence.payloadHash}`);
  return validFailureIdentity(identity)
    ? { recordIdentity: identity, identityKind }
    : undefined;
};
