import { TaggedError } from "better-result";

import { createDevErrorLogger } from "@stll/errors";

export class ClientTelemetryError extends TaggedError("ClientTelemetryError")<{
  area: string;
  message: string;
  cause?: unknown;
}> {}

export const logDevError = import.meta.env.DEV
  ? createDevErrorLogger({ echoErrors: true })
  : () => undefined;
