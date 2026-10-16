import type { ExceptionScope } from "@stll/errors";

import type { StableExceptionKey } from "./exception-fingerprint";

export type ErrorTelemetryContext = Record<string, string>;

export type CaptureErrorInput = {
  scope: ExceptionScope;
  fingerprintKey: StableExceptionKey;
  context?: ErrorTelemetryContext | undefined;
};

/** A handler-owned path; enclosing request/job/adapter scopes remain additive. */
export const handlerErrorContext = (
  fingerprintKey: StableExceptionKey,
  context?: ErrorTelemetryContext,
): CaptureErrorInput => ({
  fingerprintKey,
  scope: { type: "handler", handlerId: fingerprintKey },
  ...(context === undefined ? {} : { context }),
});
