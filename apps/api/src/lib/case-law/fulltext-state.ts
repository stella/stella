import { panic } from "better-result";
import * as v from "valibot";

import {
  DECISION_TEXT_FAILURE,
  DECISION_TEXT_RECOVERY,
  decisionTextStateSchema,
} from "@stll/api-contract/case-law-fulltext-state";
import type {
  DecisionTextFailure,
  DecisionTextRecovery,
  DecisionTextState,
} from "@stll/api-contract/case-law-fulltext-state";
import { CASE_LAW_TEXT_STATUS } from "@stll/api-contract/case-law-text-status";
import {
  parseCaseLawDecisionAst,
  visibleReaderAnchorPiecesOf,
} from "@stll/legal-ast/case-law-reader";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";
import { DAY_IN_MS } from "@stll/time";

import { errorTag } from "@/api/lib/errors/error-tag";
import {
  isReadRefusal,
  isStoredReadAbsence,
  isStoredReadUnavailable,
  READ_OUTCOME_METADATA_KEY,
} from "@/api/lib/errors/read-outcome";
import {
  AdapterFetchError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-content-hash";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";

const MINUTE_MS = 60_000;

export const FULLTEXT_RECOVERY_LIMITS = {
  ADOPTION_BATCH: 128,
  VERIFICATION_BATCH: 8,
  LISTING_PAGES: 4,
  ATTEMPT_TIMEOUT_MS: 4 * MINUTE_MS,
  CLAIM_MS: 5 * MINUTE_MS,
  INITIAL_RETRY_MS: 15 * MINUTE_MS,
  MAX_RETRY_MS: DAY_IN_MS,
  STORED_VERIFICATION_MS: 7 * DAY_IN_MS,
} as const;

/** Null belongs only to untouched rows from before the guarded rollout. */
export const readDecisionTextState = (
  value: unknown,
): DecisionTextState | null => {
  const parsed = v.safeParse(v.nullable(decisionTextStateSchema), value);
  if (!parsed.success) {
    return panic("Invalid persisted case-law full-text state");
  }
  return parsed.output;
};

/** Reusing a corpus acknowledgement requires the proof of that exact payload. */
export const hasVerifiedCorpusText = (
  state: DecisionTextState | null,
  contentHash: string | null,
): boolean =>
  state?.status === CASE_LAW_TEXT_STATUS.STORED &&
  state.storage === "corpus" &&
  state.contentHash === contentHash;

type VerifiedDecisionTextOptions = {
  payload: CorpusPayload;
  caseNumberType: DecisionPrimaryReferenceType;
  storage: "postgres" | "corpus";
  now: Date;
};

/** A pointer, block count, summary, or hash is never evidence of readable text. */
export const verifiedDecisionText = ({
  payload,
  caseNumberType,
  storage,
  now,
}: VerifiedDecisionTextOptions): Extract<
  DecisionTextState,
  { status: "stored" }
> | null => {
  const ast = parseCaseLawDecisionAst(payload.ast);
  const readable =
    stripDangerousChars(payload.text ?? "").trim().length > 0 ||
    visibleReaderAnchorPiecesOf(ast, caseNumberType).some(
      ({ text }) => stripDangerousChars(text).trim().length > 0,
    );
  if (!readable) {
    return null;
  }
  return {
    status: CASE_LAW_TEXT_STATUS.STORED,
    contentHash: corpusContentHash(payload),
    storage,
    verifiedAt: now.toISOString(),
  };
};

type PendingDecisionTextOptions = {
  now: Date;
  attemptCount: number;
  lastAttemptAt: string | null;
  delayMs: number;
  recovery?: DecisionTextRecovery;
};

export const pendingDecisionText = ({
  now,
  attemptCount,
  lastAttemptAt,
  delayMs,
  recovery = { type: DECISION_TEXT_RECOVERY.VERIFY_STORAGE },
}: PendingDecisionTextOptions): Extract<
  DecisionTextState,
  { status: "fetch_pending" }
> => ({
  status: CASE_LAW_TEXT_STATUS.FETCH_PENDING,
  attemptCount,
  lastAttemptAt,
  nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
  recovery,
});

type FailedDecisionTextOptions = {
  now: Date;
  attemptCount: number;
  cause: DecisionTextFailure;
  retryFloorMs: number;
  recovery?: DecisionTextRecovery;
};

export const failedDecisionText = ({
  now,
  attemptCount,
  cause,
  retryFloorMs,
  recovery = { type: DECISION_TEXT_RECOVERY.VERIFY_STORAGE },
}: FailedDecisionTextOptions): Extract<
  DecisionTextState,
  { status: "fetch_failed" }
> => ({
  status: CASE_LAW_TEXT_STATUS.FETCH_FAILED,
  attemptCount,
  cause,
  recovery,
  lastAttemptAt: now.toISOString(),
  nextAttemptAt: new Date(
    now.getTime() +
      Math.min(
        retryFloorMs * 2 ** Math.min(Math.max(attemptCount - 1, 0), 16),
        FULLTEXT_RECOVERY_LIMITS.MAX_RETRY_MS,
      ),
  ).toISOString(),
});

/** A missing endpoint or exhausted retry cannot establish publisher absence. */
export const textFailureFromObservation = (
  metadata: Record<string, unknown>,
): DecisionTextFailure | null => {
  const outcome = metadata[READ_OUTCOME_METADATA_KEY];
  if (isReadRefusal(outcome)) {
    return outcome.scope === "document"
      ? { kind: DECISION_TEXT_FAILURE.HTTP, status: outcome.status }
      : null;
  }
  if (isStoredReadAbsence(outcome)) {
    switch (outcome.evidence) {
      case "http-404":
        return { kind: DECISION_TEXT_FAILURE.HTTP, status: 404 };
      case "http-410":
        return { kind: DECISION_TEXT_FAILURE.HTTP, status: 410 };
      case "publisher-typed-absence":
      case "stated-zero":
        return null;
      default:
        outcome.evidence satisfies never;
        return panic("Unhandled publisher absence evidence");
    }
  }
  if (!isStoredReadUnavailable(outcome) || outcome.scope !== "document") {
    return null;
  }
  switch (outcome.cause.kind) {
    case "status":
    case "no-content":
    case "empty-body":
      return { kind: DECISION_TEXT_FAILURE.HTTP, status: outcome.cause.status };
    case "too-large":
      return {
        kind: DECISION_TEXT_FAILURE.SIZE,
        limitBytes: outcome.cause.maxBytes,
      };
    case "parser-refusal":
      return {
        kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL,
        code: outcome.cause.code,
      };
    case "thrown":
      return {
        kind: DECISION_TEXT_FAILURE.NETWORK,
        code: "publisher_read_failed",
      };
    default:
      outcome.cause satisfies never;
      return panic("Unhandled publisher read failure");
  }
};

type DecisionTextObservationOptions = VerifiedDecisionTextOptions & {
  metadata: Record<string, unknown>;
  attemptCount: number;
};

/** The constructor used by row writes and the total source-fixture guard. */
export const decisionTextObservationState = ({
  metadata,
  attemptCount,
  ...options
}: DecisionTextObservationOptions): DecisionTextState => {
  const proof = verifiedDecisionText(options);
  if (proof !== null) {
    return proof;
  }
  const cause = textFailureFromObservation(metadata);
  if (cause !== null) {
    return failedDecisionText({
      now: options.now,
      attemptCount: Math.max(attemptCount, 1),
      cause,
      retryFloorMs: FULLTEXT_RECOVERY_LIMITS.INITIAL_RETRY_MS,
    });
  }
  return pendingDecisionText({
    now: options.now,
    attemptCount,
    lastAttemptAt: null,
    delayMs: 0,
  });
};

type TextFailureFromErrorOptions = {
  error: unknown;
  phase: "publisher" | "parser" | "storage";
  timeoutMs: number;
};

export const textFailureFromError = ({
  error,
  phase,
  timeoutMs,
}: TextFailureFromErrorOptions): DecisionTextFailure => {
  if (error instanceof AdapterFetchError && error.httpStatus !== undefined) {
    return { kind: DECISION_TEXT_FAILURE.HTTP, status: error.httpStatus };
  }
  if (
    TimeoutError.is(error) ||
    (error instanceof Error && error.name === "TimeoutError")
  ) {
    return { kind: DECISION_TEXT_FAILURE.TIMEOUT, timeoutMs };
  }
  const code = errorTag(error).slice(0, 128);
  switch (phase) {
    case "publisher":
      return { kind: DECISION_TEXT_FAILURE.NETWORK, code };
    case "parser":
      return { kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL, code };
    case "storage":
      return { kind: DECISION_TEXT_FAILURE.STORAGE, code };
    default:
      phase satisfies never;
      return panic("Unhandled full-text recovery phase");
  }
};
