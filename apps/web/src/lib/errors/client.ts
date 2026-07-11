import { TaggedError } from "better-result";

export class ClientOperationError extends TaggedError("ClientOperationError")<{
  action: string;
  message: string;
  cause?: unknown;
}>() {}

export class ClientCapabilityError extends TaggedError(
  "ClientCapabilityError",
)<{
  capability: string;
  message: string;
  cause?: unknown;
}>() {}

export class ClientUnknownError extends TaggedError("ClientUnknownError")<{
  message: string;
}>() {}
