/**
 * What one read of an external source established.
 *
 * A read either produced a value, established that the source states the
 * thing does not exist, was refused by the source, or failed to find out. The
 * four stay distinct so a failed or refused read is never stored or reported
 * as an absence: an absence can only be constructed with evidence from the
 * closed {@link AbsenceEvidence} union, and a failure carries its cause.
 *
 * A refusal (401, 403, 451) is neither: the thing may exist, and asking again
 * the same way soon will not change the answer. It is stored only as a typed
 * {@link ReadRefusal} marker (never as empty text or an empty list), names
 * what it withheld (`scope`), and is re-checked on the normal cadence rather
 * than treated as a deletion.
 *
 * Read with a `switch` on `type` and an exhaustive `never` default.
 */

import { isRecord } from "@/api/lib/type-guards";

/** Why a read may conclude that the source holds nothing. */
export type AbsenceEvidence =
  /** The source answered 404 for the address. */
  | "http-404"
  /** The source answered 410 for the address. */
  | "http-410"
  /** The source stated a count of zero. */
  | "stated-zero"
  /** The source's own payload typed the item as absent. */
  | "publisher-typed-absence";

/** Why a read did not establish a value or an absence. */
export type ReadUnavailableCause =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "no-content"; readonly status: number }
  | { readonly kind: "empty-body"; readonly status: number }
  | { readonly kind: "thrown"; readonly error: unknown };

/** The statuses by which a source refuses a read. */
export const READ_REFUSAL_STATUSES = [401, 403, 451] as const;

export type ReadRefusalStatus = (typeof READ_REFUSAL_STATUSES)[number];

/**
 * What a refusal withheld: the document itself, one part of a document that
 * is otherwise read (a secondary notice, an attachment, a registry record), or
 * the whole source.
 */
export type ReadRefusalScope = "document" | "part" | "source";

/** How the source refused. */
export type ReadRefusalCause = {
  readonly kind: "http-status";
  /** The `Retry-After` the refusal carried, as served. */
  readonly retryAfter: string | null;
};

/** A typed refusal, as returned by a read and as stored on a decision. */
export type ReadRefusal = {
  readonly type: "refused";
  readonly status: ReadRefusalStatus;
  readonly scope: ReadRefusalScope;
  readonly cause: ReadRefusalCause;
};

export type ReadOutcome<T> =
  | { readonly type: "present"; readonly value: T }
  | { readonly type: "absent"; readonly evidence: AbsenceEvidence }
  | ReadRefusal
  | { readonly type: "unavailable"; readonly cause: ReadUnavailableCause };

export const readPresent = <T>(value: T): ReadOutcome<T> => ({
  type: "present",
  value,
});

export const readAbsent = <T>(evidence: AbsenceEvidence): ReadOutcome<T> => ({
  type: "absent",
  evidence,
});

export const readRefused = <T>(refusal: {
  status: ReadRefusalStatus;
  scope: ReadRefusalScope;
  cause: ReadRefusalCause;
}): ReadOutcome<T> => ({ type: "refused", ...refusal });

export const readUnavailable = <T>(
  cause: ReadUnavailableCause,
): ReadOutcome<T> => ({ type: "unavailable", cause });

/** The absence an HTTP status states on its own, if any. */
export const httpAbsenceEvidence = (status: number): AbsenceEvidence | null => {
  switch (status) {
    case 404:
      return "http-404";
    case 410:
      return "http-410";
    default:
      return null;
  }
};

/** The refusal an HTTP status states on its own, if any. */
export const httpRefusalStatus = (status: number): ReadRefusalStatus | null =>
  READ_REFUSAL_STATUSES.find((refusal) => refusal === status) ?? null;

/** Whether a value is a typed refusal marker. */
export const isReadRefusal = (value: unknown): value is ReadRefusal =>
  isRecord(value) &&
  value["type"] === "refused" &&
  typeof value["status"] === "number" &&
  httpRefusalStatus(value["status"]) !== null &&
  (value["scope"] === "document" ||
    value["scope"] === "part" ||
    value["scope"] === "source");

/**
 * What an HTTP status establishes about a read that expected content.
 *
 * 404 and 410 are the only statuses that state an absence; 401, 403 and 451
 * are refusals of what `scope` names. A 204, every other non-2xx status, and
 * any status outside the HTTP range are failures to read.
 */
export const readOutcomeOfStatus = (
  status: number,
  scope: ReadRefusalScope,
  retryAfter: string | null = null,
): ReadOutcome<"content"> => {
  const evidence = httpAbsenceEvidence(status);
  if (evidence !== null) {
    return readAbsent(evidence);
  }
  const refusal = httpRefusalStatus(status);
  if (refusal !== null) {
    return readRefused({
      status: refusal,
      scope,
      cause: { kind: "http-status", retryAfter },
    });
  }
  if (status === 204) {
    return readUnavailable({ kind: "no-content", status });
  }
  if (status >= 200 && status < 300) {
    return readPresent("content");
  }
  return readUnavailable({ kind: "status", status });
};
