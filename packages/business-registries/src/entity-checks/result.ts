import { Result, TaggedError } from "better-result";
import type { Err } from "better-result";
import { Temporal } from "temporal-polyfill/full";

// Entity checks are yes/no screening questions put to an official source
// ("is this company in insolvency proceedings?"), not company lookups.
// Every check resolves to exactly one outcome:
//
//   clear         the source positively answered and holds nothing adverse
//   found         the source returned adverse records (typed findings)
//   unavailable   the source could not answer (transport error, timeout,
//                 outage page, SOAP fault, error code, unparseable body)
//   not-covered   the source cannot answer for this kind of subject
//
// `unavailable` is never collapsed into `clear`: the only path to `clear` is
// a parser that recognised the source's explicit empty answer.

/** What the check is asked about. Each check declares which types it answers. */
export type EntityCheckSubject =
  | {
      type: "company-id";
      /** National business identifier of the check's jurisdiction (IČO). */
      value: string;
    }
  | {
      type: "person";
      firstName: string;
      lastName: string;
      /** ISO 8601 calendar date (YYYY-MM-DD). */
      birthDate: string;
    };

export const ENTITY_CHECK_SUBJECT_TYPES = [
  "company-id",
  "person",
] as const satisfies readonly EntityCheckSubject["type"][];

export type EntityCheckSubjectType =
  (typeof ENTITY_CHECK_SUBJECT_TYPES)[number];

/** The official source a check queries, for attribution next to the answer. */
export type EntityCheckSource = {
  name: string;
  authority: string;
  url: string;
};

export const ENTITY_CHECK_UNAVAILABLE_REASONS = [
  "timeout",
  "network",
  "http-error",
  "outage-page",
  "soap-fault",
  "malformed-response",
  "source-error",
] as const;

export type EntityCheckUnavailableReason =
  (typeof ENTITY_CHECK_UNAVAILABLE_REASONS)[number];

export const ENTITY_CHECK_NOT_COVERED_REASONS = [
  "subject-type-not-supported",
] as const;

export type EntityCheckNotCoveredReason =
  (typeof ENTITY_CHECK_NOT_COVERED_REASONS)[number];

type EntityCheckOutcomeBase<TKind extends string> = {
  kind: TKind;
  source: EntityCheckSource;
  subject: EntityCheckSubject;
};

export type EntityCheckOutcome<TKind extends string, TFinding> =
  | (EntityCheckOutcomeBase<TKind> & {
      status: "clear";
      /** ISO instant the source was queried. */
      checkedAt: string;
      /** When the source last refreshed its data, if it says so. */
      sourceDataAsOf: string | null;
    })
  | (EntityCheckOutcomeBase<TKind> & {
      status: "found";
      checkedAt: string;
      sourceDataAsOf: string | null;
      findings: [TFinding, ...TFinding[]];
      /** Matches the source reported, which can exceed the findings returned. */
      totalMatches: number;
    })
  | (EntityCheckOutcomeBase<TKind> & {
      status: "unavailable";
      checkedAt: string;
      reason: EntityCheckUnavailableReason;
      /** Source-provided error code or HTTP status, never a raw body. */
      detail: string | null;
    })
  | (EntityCheckOutcomeBase<TKind> & {
      status: "not-covered";
      reason: EntityCheckNotCoveredReason;
      supportedSubjectTypes: EntityCheckSubjectType[];
    });

export type EntityCheckStatus = EntityCheckOutcome<string, unknown>["status"];

/** What a source client reports once it has an explicit answer. */
export type SourceAnswer<TFinding> =
  | { type: "clear"; sourceDataAsOf: string | null }
  | {
      type: "found";
      sourceDataAsOf: string | null;
      totalMatches: number;
      findings: [TFinding, ...TFinding[]];
    };

/**
 * A failure that makes the source's answer unusable. Source clients return it
 * as an `Err` and the check boundary turns it into an `unavailable` outcome,
 * so no parse path can fall through to `clear`.
 */
export class EntityCheckUnavailableError extends TaggedError(
  "EntityCheckUnavailableError",
)<{
  message: string;
  reason: EntityCheckUnavailableReason;
  /** Source error code or HTTP status; never a raw body. */
  detail: string | null;
}> {}

/** The caller aborted the check; not an answer from the source. */
export class EntityCheckCancelledError extends TaggedError(
  "EntityCheckCancelledError",
)<{ message: string }> {}

export type EntityCheckSourceError =
  | EntityCheckUnavailableError
  | EntityCheckCancelledError;

export const unavailable = ({
  reason,
  message,
  detail,
}: {
  reason: EntityCheckUnavailableReason;
  message: string;
  detail?: string | null;
}): Err<never, EntityCheckUnavailableError> =>
  Result.err(
    new EntityCheckUnavailableError({
      message,
      reason,
      detail: detail ?? null,
    }),
  );

export const nowInstant = (): string => Temporal.Now.instant().toString();
