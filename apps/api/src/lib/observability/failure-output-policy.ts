import type { FailureGrade } from "@stll/errors";

import type { OutputPolicy } from "@/api/lib/observability/failure";

type GradePolicy = OutputPolicy & {
  readonly escalation?: "sustained";
};

/** Exception capture is determined by the grade, including at legacy sinks. */
const FAILURE_OUTPUT_POLICY = {
  anticipated: { severity: "WARN", capture: false },
  transient: { severity: "WARN", capture: false, escalation: "sustained" },
  client: { severity: "WARN", capture: false },
  defect: { severity: "ERROR", capture: true },
} as const satisfies Record<FailureGrade, GradePolicy>;

export const failureOutputPolicy = (grade: FailureGrade): GradePolicy =>
  FAILURE_OUTPUT_POLICY[grade];
