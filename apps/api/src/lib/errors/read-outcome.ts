/**
 * What one read of an external source established.
 *
 * A read either produced a value, established that the source states the
 * thing does not exist, or failed to find out. The three stay distinct so a
 * failed read is never stored or reported as an absence: an absence can only
 * be constructed with evidence from the closed {@link AbsenceEvidence} union,
 * and a failure carries its cause.
 *
 * Read with a `switch` on `type` and an exhaustive `never` default.
 */

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

export type ReadOutcome<T> =
  | { readonly type: "present"; readonly value: T }
  | { readonly type: "absent"; readonly evidence: AbsenceEvidence }
  | { readonly type: "unavailable"; readonly cause: ReadUnavailableCause };

export const readPresent = <T>(value: T): ReadOutcome<T> => ({
  type: "present",
  value,
});

export const readAbsent = <T>(evidence: AbsenceEvidence): ReadOutcome<T> => ({
  type: "absent",
  evidence,
});

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

/**
 * What an HTTP status establishes about a read that expected content.
 *
 * 404 and 410 are the only statuses that state an absence. A 204, every other
 * non-2xx status, and any status outside the HTTP range are failures to read.
 */
export const readOutcomeOfStatus = (status: number): ReadOutcome<"content"> => {
  const evidence = httpAbsenceEvidence(status);
  if (evidence !== null) {
    return readAbsent(evidence);
  }
  if (status === 204) {
    return readUnavailable({ kind: "no-content", status });
  }
  if (status >= 200 && status < 300) {
    return readPresent("content");
  }
  return readUnavailable({ kind: "status", status });
};
