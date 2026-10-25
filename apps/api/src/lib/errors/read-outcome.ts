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
  /** The served body exceeded the reader's byte ceiling; reading stopped. */
  | { readonly kind: "too-large"; readonly maxBytes: number }
  | { readonly kind: "thrown"; readonly error: unknown };

/** The statuses by which a source refuses a read. */
const READ_REFUSAL_STATUSES = [401, 403, 451] as const;

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
const httpAbsenceEvidence = (status: number): AbsenceEvidence | null => {
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
const httpRefusalStatus = (status: number): ReadRefusalStatus | null =>
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

// ── Read outcomes as stored on a decision ──

/**
 * The metadata key under which a decision states the typed outcome of a read
 * it was stored without: a {@link StoredReadUnavailable}, a
 * {@link ReadRefusal}, or a {@link StoredReadAbsence}.
 */
export const READ_OUTCOME_METADATA_KEY = "readOutcome";

/**
 * Consecutive cycles a stored item's read may stay unavailable before the
 * pipeline keeps its row with a typed outcome and moves on, instead of
 * failing the page again.
 */
export const UNAVAILABLE_CYCLES_BEFORE_MARKING = 3;

/** A {@link ReadUnavailableCause} reduced to what can be stored. */
export type StoredReadUnavailableCause =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "no-content"; readonly status: number }
  | { readonly kind: "empty-body"; readonly status: number }
  | { readonly kind: "too-large"; readonly maxBytes: number }
  | { readonly kind: "thrown" };

/**
 * A read that stayed unavailable, as stored: what it withheld, why, and for
 * how many consecutive cycles. It is re-checked on the normal cadence.
 *
 * - scope "part": one part of a decision whose main text was read (a notice,
 *   a record card, an abstract). The decision is stored with this marker.
 *   A failed main text or AST is never a part: it fails the item.
 * - scope "document": the decision's own document. A stored row keeps its
 *   content and gains this marker; a row never stored is held listing-only
 *   with it as the reason.
 */
export type StoredReadUnavailable = {
  readonly type: "unavailable";
  readonly scope: "document" | "part";
  readonly cause: StoredReadUnavailableCause;
  readonly consecutiveCycles: number;
};

/** An absence the source stated, as stored. */
export type StoredReadAbsence = {
  readonly type: "absent";
  readonly evidence: AbsenceEvidence;
};

/** The typed outcome a decision carries for a read it was stored without. */
export type StoredReadOutcome =
  | StoredReadUnavailable
  | ReadRefusal
  | StoredReadAbsence;

const storedCause = (
  cause: ReadUnavailableCause,
): StoredReadUnavailableCause =>
  cause.kind === "thrown" ? { kind: "thrown" } : cause;

export const storedReadUnavailable = ({
  cause,
  scope,
  consecutiveCycles,
}: {
  cause: ReadUnavailableCause;
  scope: StoredReadUnavailable["scope"];
  consecutiveCycles: number;
}): StoredReadUnavailable => ({
  type: "unavailable",
  scope,
  cause: storedCause(cause),
  consecutiveCycles,
});

const ABSENCE_EVIDENCE: ReadonlySet<unknown> = new Set<AbsenceEvidence>([
  "http-404",
  "http-410",
  "stated-zero",
  "publisher-typed-absence",
]);

// Total over the stored cause kinds, so a new kind cannot be stored without
// the guard accepting it.
const UNAVAILABLE_KIND_RECORD = {
  status: true,
  "no-content": true,
  "empty-body": true,
  "too-large": true,
  thrown: true,
} as const satisfies Record<StoredReadUnavailableCause["kind"], true>;

const UNAVAILABLE_KINDS: ReadonlySet<unknown> = new Set(
  Object.keys(UNAVAILABLE_KIND_RECORD),
);

/** Whether a value is a stored unavailable marker. */
export const isStoredReadUnavailable = (
  value: unknown,
): value is StoredReadUnavailable =>
  isRecord(value) &&
  value["type"] === "unavailable" &&
  (value["scope"] === "document" || value["scope"] === "part") &&
  isRecord(value["cause"]) &&
  UNAVAILABLE_KINDS.has(value["cause"]["kind"]) &&
  typeof value["consecutiveCycles"] === "number" &&
  Number.isInteger(value["consecutiveCycles"]) &&
  value["consecutiveCycles"] >= 1;

/** Whether a value is a stored absence marker. */
export const isStoredReadAbsence = (
  value: unknown,
): value is StoredReadAbsence =>
  isRecord(value) &&
  value["type"] === "absent" &&
  ABSENCE_EVIDENCE.has(value["evidence"]);
