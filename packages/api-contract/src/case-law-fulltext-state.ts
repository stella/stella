import * as v from "valibot";

import { apiDateTimeSchema } from "./api-date";
import { CASE_LAW_TEXT_STATUS } from "./case-law-text-status.ts";

export const caseLawTextStatusSchema = v.picklist(
  Object.values(CASE_LAW_TEXT_STATUS),
);

export const DECISION_TEXT_FAILURE = {
  HTTP: "http",
  PARSER_REFUSAL: "parser_refusal",
  SIZE: "size",
  TIMEOUT: "timeout",
  NETWORK: "network",
  STORAGE: "storage",
} as const;

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const attemptCount = v.pipe(v.number(), v.integer(), v.minValue(0));
const code = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const contentHash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
// The recovery queue indexes these strings, so equal instants have one spelling.
const stateInstant = v.pipe(
  apiDateTimeSchema,
  v.check((value) => {
    const instant = new Date(value);
    return (
      Number.isFinite(instant.getTime()) && instant.toISOString() === value
    );
  }, "Expected a UTC instant with millisecond precision"),
);

/** Codes and numeric limits only: publisher bodies and error messages stay out. */
export const decisionTextFailureSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal(DECISION_TEXT_FAILURE.HTTP),
    status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
  }),
  v.strictObject({
    kind: v.literal(DECISION_TEXT_FAILURE.PARSER_REFUSAL),
    code,
  }),
  v.strictObject({
    kind: v.literal(DECISION_TEXT_FAILURE.SIZE),
    limitBytes: positiveInteger,
  }),
  v.strictObject({
    kind: v.literal(DECISION_TEXT_FAILURE.TIMEOUT),
    timeoutMs: positiveInteger,
  }),
  v.strictObject({ kind: v.literal(DECISION_TEXT_FAILURE.NETWORK), code }),
  v.strictObject({ kind: v.literal(DECISION_TEXT_FAILURE.STORAGE), code }),
]);
export type DecisionTextFailure = v.InferOutput<
  typeof decisionTextFailureSchema
>;

export const DECISION_TEXT_RECOVERY = {
  VERIFY_STORAGE: "verify_storage",
  PUBLISHER_LISTING: "publisher_listing",
  STORED_RAW_RETRY: "stored_raw_retry",
} as const;
const decisionTextRecoverySchema = v.variant("type", [
  v.strictObject({ type: v.literal(DECISION_TEXT_RECOVERY.VERIFY_STORAGE) }),
  v.strictObject({ type: v.literal(DECISION_TEXT_RECOVERY.STORED_RAW_RETRY) }),
  v.strictObject({
    type: v.literal(DECISION_TEXT_RECOVERY.PUBLISHER_LISTING),
    slice: code,
    page: attemptCount,
  }),
]);
export type DecisionTextRecovery = v.InferOutput<
  typeof decisionTextRecoverySchema
>;

export const publisherTextAbsenceEvidenceSchema = v.strictObject({
  recordUrl: v.pipe(
    v.string(),
    v.url(),
    v.regex(
      /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?:[/?#][^\s]*)?$/u,
    ),
  ),
  sourceHash: contentHash,
  field: code,
  kind: v.picklist([
    "explicit_statement",
    "empty_text_field",
    "no_document_attachment",
  ]),
});
export type PublisherTextAbsenceEvidence = v.InferOutput<
  typeof publisherTextAbsenceEvidenceSchema
>;

export const decisionTextStateSchema = v.variant("status", [
  v.strictObject({
    status: v.literal(CASE_LAW_TEXT_STATUS.STORED),
    storage: v.picklist(["postgres", "corpus"]),
    contentHash,
    verifiedAt: stateInstant,
  }),
  v.strictObject({
    status: v.literal(CASE_LAW_TEXT_STATUS.PUBLISHER_HAS_NO_TEXT),
    observedAt: stateInstant,
    evidence: publisherTextAbsenceEvidenceSchema,
  }),
  v.strictObject({
    status: v.literal(CASE_LAW_TEXT_STATUS.FETCH_PENDING),
    attemptCount,
    nextAttemptAt: stateInstant,
    lastAttemptAt: v.nullable(stateInstant),
    recovery: decisionTextRecoverySchema,
  }),
  v.strictObject({
    status: v.literal(CASE_LAW_TEXT_STATUS.FETCH_FAILED),
    attemptCount: positiveInteger,
    lastAttemptAt: stateInstant,
    nextAttemptAt: stateInstant,
    cause: decisionTextFailureSchema,
    recovery: decisionTextRecoverySchema,
  }),
  v.strictObject({
    status: v.literal(CASE_LAW_TEXT_STATUS.METADATA_ONLY_BY_SOURCE),
    observedAt: stateInstant,
    policy: code,
  }),
]);
export type DecisionTextState = v.InferOutput<typeof decisionTextStateSchema>;
