import { TaggedError } from "better-result";

import { declareFailureClass } from "@stll/errors";
import type { FailureReason } from "@stll/errors";
import type { SanctionsSource } from "@stll/sanctions";

import {
  failureSink,
  gradeFailure,
  pgIdentityFields,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { logger } from "@/api/lib/observability/logger";
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

type SanctionsScreeningFailureStage =
  | "matcher-pool"
  | "public-matcher"
  | "public-warmup"
  | "list-screening"
  | "whole-screening";

const SCREENING_FAILURE_REASON = {
  closed: "sanctions_matcher_closed",
  admission: "sanctions_matcher_saturated",
  deadline: "sanctions_matcher_deadline",
  "work-limit": "sanctions_screening_work_limit",
  "worker-create": "sanctions_screening_failed",
  "worker-error": "sanctions_screening_failed",
  "worker-exit": "sanctions_screening_failed",
  "worker-send": "sanctions_screening_failed",
  "worker-reply": "sanctions_screening_failed",
  "worker-retire": "sanctions_screening_failed",
  "short-read": "sanctions_screening_failed",
  "matcher-unavailable": "sanctions_screening_failed",
  "truncated-empty": "sanctions_screening_failed",
  // Read/operation boundaries retain the shared infrastructure classification.
  "freshness-read": "unclassified",
  "entries-read": "unclassified",
  "index-load": "unclassified",
  operation: "unclassified",
} as const satisfies Record<SanctionsScreeningFailureCause, FailureReason>;

export class SanctionsScreeningFailure extends TaggedError(
  "SanctionsScreeningFailure",
)<{
  message: string;
  stage: SanctionsScreeningFailureStage;
  reason: SanctionsScreeningFailureCause;
  cause?: unknown;
}> {
  static {
    declareFailureClass(this, ({ reason, cause }) => {
      const declared = SCREENING_FAILURE_REASON[reason];
      return declared === "unclassified" && cause !== undefined
        ? gradeFailure(readEvidence(cause), SCREENING_FAILURE_SINK).reason
        : declared;
    });
  }
}

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
      ? error
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

/** The lease owns diagnostics; its screening caller owns failure capture. */
export const reportSanctionsMatcherFailure = ({
  stage,
  reason,
}: ReportScreeningFailureOptions): void => {
  logger.warn("sanctions.matcher_failed", {
    feature: "sanctions.screening",
    stage,
    phase: reason,
  });
};
