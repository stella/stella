/**
 * AVT (Anchor Verification Tool) domain types, read off the list
 * verification API so a change to the wire shape surfaces here as a type
 * error. The claim states, the anchor-fact model and the review layer are
 * the investigative-methodology design of the original AVT prototype.
 */

import type { TranslationKey } from "@/i18n/types";
import type { WebApiRoutes } from "@/lib/eden-client";

type ListsRoutes = WebApiRoutes["lists"][":workspaceId"];

export type VerificationRun =
  ListsRoutes["verifications"][":runId"]["get"]["response"][200];
export type VerificationRunStatus = VerificationRun["status"];
export type VerificationErrorCode = NonNullable<VerificationRun["errorCode"]>;
export type VerificationRunSummary =
  ListsRoutes["verifications"]["get"]["response"][200]["items"][number];

export type VerificationClaim = VerificationRun["claims"][number];
export type ClaimReview = NonNullable<VerificationClaim["review"]>;
export type ClaimVerdict = VerificationClaim["verdict"];
export type ClaimState = ClaimVerdict["state"];
export type ClaimType = VerificationClaim["type"];
type ClaimRef = VerificationClaim["refs"][number];
export type ClaimFactRelation = ClaimRef["rel"];
export type ClaimAnchor = VerificationClaim["anchor"];
export type RecordConflict = NonNullable<ClaimVerdict["recordConflict"]>;

export type EvidenceFact = VerificationRun["evidence"]["facts"][number];
export type FactId = EvidenceFact["factEntityId"];

export type ClaimReviewEvent =
  ListsRoutes["claim-reviews"]["post"]["body"]["event"];
export type ClaimReviewStatus = NonNullable<ClaimReview["status"]>;
export type ClaimOverrideState = NonNullable<ClaimReview["override"]>;

export type ListItem =
  ListsRoutes[":listId"]["items"]["get"]["response"][200]["items"][number];
export type FactDetails = NonNullable<ListItem["factDetails"]>;
export type FactDetailsBody = ListsRoutes["item-fact-details"]["put"]["body"];
export type FactConfidence = FactDetails["confidence"];
export type FactDatePrecision = NonNullable<FactDetails["occurredOnPrecision"]>;

export const CLAIM_OVERRIDE_STATES = [
  "supported",
  "tension",
  "contradicted",
  "nocover",
  "notverifiable",
] as const satisfies readonly ClaimOverrideState[];

true satisfies Exclude<
  ClaimOverrideState,
  (typeof CLAIM_OVERRIDE_STATES)[number]
> extends never
  ? true
  : never;

export const FACT_CONFIDENCES = [
  "high",
  "medium",
  "low",
] as const satisfies readonly FactConfidence[];

true satisfies Exclude<
  FactConfidence,
  (typeof FACT_CONFIDENCES)[number]
> extends never
  ? true
  : never;

export const CONFIDENCE_LABEL_KEYS = {
  high: "common.high",
  medium: "common.medium",
  low: "common.low",
} as const satisfies Record<FactConfidence, TranslationKey>;

type StateMeta = {
  state: ClaimState;
  labelKey: TranslationKey;
  chipKey: TranslationKey;
};

export const STATE_META = {
  supported: {
    state: "supported",
    labelKey: "avt.states.supported.label",
    chipKey: "avt.states.supported.chip",
  },
  tension: {
    state: "tension",
    labelKey: "avt.states.tension.label",
    chipKey: "avt.states.tension.chip",
  },
  contradicted: {
    state: "contradicted",
    labelKey: "avt.states.contradicted.label",
    chipKey: "avt.states.contradicted.chip",
  },
  nocover: {
    state: "nocover",
    labelKey: "avt.states.nocover.label",
    chipKey: "avt.states.nocover.chip",
  },
  recordconflict: {
    state: "recordconflict",
    labelKey: "avt.states.recordconflict.label",
    chipKey: "avt.states.recordconflict.chip",
  },
  notverifiable: {
    state: "notverifiable",
    labelKey: "avt.states.notverifiable.label",
    chipKey: "avt.states.notverifiable.chip",
  },
} as const satisfies Record<ClaimState, StateMeta>;

type ClaimTypeMeta = {
  type: ClaimType;
  labelKey: TranslationKey;
  verifiable: boolean;
  hintKey: TranslationKey;
};

export const CLAIM_TYPE_META = {
  fact: {
    type: "fact",
    labelKey: "common.fact",
    verifiable: true,
    hintKey: "avt.claimTypes.fact.hint",
  },
  opinion: {
    type: "opinion",
    labelKey: "avt.claimTypes.opinion.label",
    verifiable: false,
    hintKey: "avt.claimTypes.opinion.hint",
  },
  unverifiable: {
    type: "unverifiable",
    labelKey: "avt.claimTypes.unverifiable.label",
    verifiable: false,
    hintKey: "avt.claimTypes.unverifiable.hint",
  },
} as const satisfies Record<ClaimType, ClaimTypeMeta>;

export const RUN_STATUS_LABEL_KEYS = {
  queued: "common.queued",
  running: "avt.runs.status.running",
  completed: "common.verified",
  failed: "common.failed",
} as const satisfies Record<VerificationRunStatus, TranslationKey>;

export const RUN_ERROR_KEYS = {
  pin_unresolved: "avt.runs.errors.pinUnresolved",
  pin_content_changed: "avt.runs.errors.pinContentChanged",
  unsupported_format: "avt.runs.errors.unsupportedFormat",
  no_text: "avt.runs.errors.noText",
  ai_unavailable: "avt.runs.errors.aiUnavailable",
  extraction_failed: "avt.runs.errors.extractionFailed",
  grading_failed: "avt.runs.errors.gradingFailed",
  enqueue_failed: "avt.runs.errors.enqueueFailed",
  internal: "avt.runs.errors.internal",
} as const satisfies Record<VerificationErrorCode, TranslationKey>;
