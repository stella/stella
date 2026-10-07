import { TaggedError } from "better-result";

import type { SanctionsSource } from "@stll/sanctions";

import { failureSink, pgIdentityFields } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { emitFailureMetric } from "@/api/lib/observability/request-metrics";

const SANCTIONS_MATCHER_FAILURE_CAUSES = [
  "closed",
  "admission",
  "deadline",
  "worker-create",
  "worker-error",
  "worker-exit",
  "worker-send",
  "worker-reply",
  "worker-retire",
  "operation",
] as const;

export type SanctionsMatcherFailureCause =
  (typeof SANCTIONS_MATCHER_FAILURE_CAUSES)[number];

export type SanctionsScreeningFailureCause =
  | SanctionsMatcherFailureCause
  | "freshness-read"
  | "entries-read"
  | "short-read"
  | "index-load"
  | "work-limit"
  | "matcher-unavailable"
  | "truncated-empty";

export type SanctionsScreeningFailureStage =
  | "matcher-pool"
  | "public-matcher"
  | "list-screening"
  | "whole-screening";

export class SanctionsScreeningFailure extends TaggedError(
  "SanctionsScreeningFailure",
)<{
  message: string;
  stage: SanctionsScreeningFailureStage;
  reason: SanctionsScreeningFailureCause;
  cause?: unknown;
}> {}

type SanctionsDriverEvidenceOptions = {
  code: string;
  errno: string | undefined;
};

// Driver provenance requires an untagged Error; this projection contains no raw payload.
class SanctionsDriverEvidenceError extends Error {
  readonly code: string;
  readonly errno: string | undefined;

  constructor({ code, errno }: SanctionsDriverEvidenceOptions) {
    super("Sanctions database read failed");
    this.name = "SanctionsDriverEvidenceError";
    this.code = code;
    this.errno = errno;
  }
}

const SCREENING_FAILURE_SINK = failureSink({
  event: "sanctions.screening_failed",
  expected: [],
});

type ReportScreeningFailureOptions = {
  stage: SanctionsScreeningFailureStage;
  reason: SanctionsScreeningFailureCause;
  source?: SanctionsSource;
  error?: unknown;
};

/** Preserve bounded driver evidence, never query text, messages or identity fields. */
export const reportSanctionsScreeningFailure = ({
  stage,
  reason,
  source,
  error,
}: ReportScreeningFailureOptions): void => {
  const fields = pgIdentityFields(readEvidence(error));
  const sqlState = fields["error.cause.pg_code"];
  const driverCode = fields["error.cause.pg_driver_code"];
  const code = driverCode ?? sqlState;
  const cause =
    code === undefined
      ? undefined
      : new SanctionsDriverEvidenceError({ code, errno: sqlState });
  observeFailure(
    new SanctionsScreeningFailure({
      message: "Sanctions screening unavailable",
      stage,
      reason,
      cause,
    }),
    {
      sink: SCREENING_FAILURE_SINK,
      ctx: {
        feature: "sanctions.screening",
        stage,
        phase: reason,
        ...(source === undefined ? {} : { source }),
      },
    },
  );
  emitFailureMetric({
    sink: SCREENING_FAILURE_SINK.event,
    reason: "unavailable",
  });
};
