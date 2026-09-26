import { TaggedError } from "better-result";

/**
 * Why a CourtListener record cannot become a decision. Every reason rejects
 * the whole cluster: no opinion, citation or judge of it is admitted alone.
 */
export const COURTLISTENER_REJECTION_REASON = {
  SCHEMA_DRIFT: "schema-drift",
  INVALID_RECORD: "invalid-record",
  INCOMPLETE_CLUSTER: "incomplete-cluster",
  OVER_LIMIT: "over-limit",
  COURT_UNKNOWN: "court-unknown",
  COURT_REJECTED: "court-rejected",
  COURT_NOT_WRITABLE: "court-not-writable",
  MISSING_PRIMARY_REFERENCE: "missing-primary-reference",
  INVALID_IDENTIFIER: "invalid-identifier",
  IDENTIFIER_OVERFLOW: "identifier-overflow",
  /** Some opinion has no text representation a parser could use. */
  NO_USABLE_TEXT: "no-usable-text",
  /** Some opinion's text depends on images or scans nothing captured. */
  REQUIRES_ASSETS: "requires-assets",
} as const;

export type CourtListenerRejectionReason =
  (typeof COURTLISTENER_REJECTION_REASON)[keyof typeof COURTLISTENER_REJECTION_REASON];

/**
 * Where in the record a check failed. `detail` is written by the mapper, never
 * copied from a publisher value, so no source text reaches an error message.
 */
export type RejectionDiagnostic = {
  readonly path: string;
  readonly detail: string;
};

const MAX_DIAGNOSTICS = 32;
const MAX_PATH_LENGTH = 200;

export class CourtListenerRecordRejectedError extends TaggedError(
  "CourtListenerRecordRejectedError",
)<{
  message: string;
  reason: CourtListenerRejectionReason;
  /** `cluster:<id>`, or a digest of the input where no cluster ID was readable. */
  sourceRecordKey: string;
  clusterId: string | null;
  diagnostics: readonly RejectionDiagnostic[];
  /** Diagnostics past the bound, counted rather than kept. */
  omittedDiagnostics: number;
  opinionIds: readonly string[];
}> {}

type RejectCourtListenerRecordOptions = {
  readonly reason: CourtListenerRejectionReason;
  readonly sourceRecordKey: string;
  readonly clusterId: string | null;
  readonly diagnostics: readonly RejectionDiagnostic[];
  readonly opinionIds?: readonly string[] | undefined;
};

export const rejectCourtListenerRecord = ({
  clusterId,
  diagnostics,
  opinionIds = [],
  reason,
  sourceRecordKey,
}: RejectCourtListenerRecordOptions): CourtListenerRecordRejectedError =>
  new CourtListenerRecordRejectedError({
    message: `CourtListener cluster ${clusterId ?? "(unidentified)"} rejected: ${reason}`,
    reason,
    sourceRecordKey,
    clusterId,
    diagnostics: diagnostics
      .slice(0, MAX_DIAGNOSTICS)
      .map(({ detail, path }) => ({
        path: path.slice(0, MAX_PATH_LENGTH),
        detail: detail.slice(0, MAX_PATH_LENGTH),
      })),
    omittedDiagnostics: Math.max(0, diagnostics.length - MAX_DIAGNOSTICS),
    opinionIds: opinionIds.slice(0, MAX_DIAGNOSTICS),
  });
