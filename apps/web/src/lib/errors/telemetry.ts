import { TaggedError } from "better-result";

export class ClientTelemetryError extends TaggedError("ClientTelemetryError")<{
  area: string;
  message: string;
  cause?: unknown;
}>() {}
