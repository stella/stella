import * as v from "valibot";

import { apiDateTimeSchema } from "@stll/api-contract/api-date";

const revision = {
  decisionId: v.pipe(v.string(), v.uuid()),
  sourceId: v.pipe(v.string(), v.uuid()),
  observedAt: apiDateTimeSchema,
  sourceObservedAt: v.nullable(apiDateTimeSchema),
  sourceObservationOrder: v.nullable(v.pipe(v.string(), v.regex(/^\d+$/u))),
};

export const removalEvidenceSchema = v.variant("type", [
  v.strictObject({
    ...revision,
    type: v.literal("publisher-absence"),
    sourceDocumentId: v.string(),
    absence: v.picklist(["http-404", "http-410", "publisher-typed-absence"]),
  }),
  v.strictObject({
    ...revision,
    type: v.literal("existing-redaction"),
    sourceDocumentId: v.nullable(v.string()),
  }),
]);
export type RemovalEvidence = v.InferOutput<typeof removalEvidenceSchema>;

export const REMOVAL_SUPERSEDED_REASON = {
  IDENTITY_CHANGED: "publisher-identity-changed",
  OBSERVATION_CHANGED: "publisher-observation-changed",
  RESTORED: "publisher-restored",
  CANONICAL_CHANGED: "canonical-decision-changed",
} as const;
export type RemovalSupersededReason =
  (typeof REMOVAL_SUPERSEDED_REASON)[keyof typeof REMOVAL_SUPERSEDED_REASON];

type RemovalDecisionRevision = {
  id: string;
  sourceId: string;
  sourceDocumentId: string | null;
  sourceObservedAt: Date | null;
  sourceObservationOrder: bigint | null;
  redactedAt: Date | null;
};

/** Ingestion advances this revision even when the arriving content is unchanged. */
export const supersededRemovalEvidence = (
  evidence: RemovalEvidence,
  decision: RemovalDecisionRevision,
): RemovalSupersededReason | null => {
  if (
    evidence.decisionId !== decision.id ||
    evidence.sourceId !== decision.sourceId ||
    evidence.sourceDocumentId !== decision.sourceDocumentId
  ) {
    return REMOVAL_SUPERSEDED_REASON.IDENTITY_CHANGED;
  }
  if (
    evidence.sourceObservationOrder !==
      (decision.sourceObservationOrder?.toString() ?? null) ||
    evidence.sourceObservedAt !==
      (decision.sourceObservedAt?.toISOString() ?? null)
  ) {
    return REMOVAL_SUPERSEDED_REASON.OBSERVATION_CHANGED;
  }
  if (evidence.type === "existing-redaction" && decision.redactedAt === null) {
    return REMOVAL_SUPERSEDED_REASON.RESTORED;
  }
  return null;
};
