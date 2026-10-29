import { panic } from "better-result";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";

import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { getRequestId } from "@/api/lib/observability/request-context";
import { LimiterStoreUnavailableError } from "@/api/lib/rate-limit/store-unavailable";

const LIMITER_ADMISSION_FAILURE = failureSink({
  event: "limiter_admission.unavailable",
  expected: [],
});

export const observeLimiterAdmissionFailure = (
  error: unknown,
  operation: "mcp" | "limiter" | "admission",
): void => {
  if (ActionAdmissionError.is(error)) {
    switch (error.reason) {
      case "store_unavailable":
      case "configuration_incomplete":
      case "organization_state_unreadable":
      case "lease_lost":
        break;
      case "busy":
      case "period_exhausted":
      case "daily_exhausted":
      case "not_enabled":
      case "not_on_plan":
      case "feature_disabled":
        return;
      default:
        error.reason satisfies never;
        return panic("Unhandled admission failure reason");
    }
  } else if (
    !LimiterStoreUnavailableError.is(error) &&
    resolveHandlerError(error)?.code !== LIMITER_STORE_UNAVAILABLE.code
  ) {
    return;
  }
  const requestId = getRequestId();
  observeFailure(error, {
    sink: LIMITER_ADMISSION_FAILURE,
    ctx: { operation, ...(requestId === undefined ? {} : { requestId }) },
  });
};
