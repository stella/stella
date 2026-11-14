import type { ExceptionScope } from "./exception-scope";

/** A source-owned function/path label, never an entity ID or stack symbol. */
export type StableExceptionKey = `${string}.${string}`;

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
) =>
  ({
    fingerprintKey,
    scope: { type: "handler", handlerId: fingerprintKey },
    ...(context === undefined ? {} : { context }),
  }) satisfies CaptureErrorInput;
