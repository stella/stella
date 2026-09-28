import { TaggedError } from "better-result";

import { createDevErrorLogger } from "@stll/errors";

export class ClientTelemetryError extends TaggedError("ClientTelemetryError")<{
  area: string;
  message: string;
  cause?: unknown;
}> {}

export const logDevError = createDevErrorLogger({
  echoErrors: import.meta.env.DEV,
});
