import { TaggedError } from "better-result";

export class ClientOperationError extends TaggedError("ClientOperationError")<{
  action: string;
  message: string;
  cause?: unknown;
}> {}

export class ClientCapabilityError extends TaggedError(
  "ClientCapabilityError",
)<{
  capability: string;
  message: string;
  cause?: unknown;
}> {}

export class ClientUnknownError extends TaggedError("ClientUnknownError")<{
  message: string;
}> {}

export const transformUnknownError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }

  if (error === undefined || error === null) {
    return new ClientUnknownError({
      message: "Unknown error (null or undefined)",
    });
  }

  if (typeof error === "object") {
    return new ClientUnknownError({
      message: JSON.stringify(error),
    });
  }

  return new ClientUnknownError({
    message: typeof error === "string" ? error : JSON.stringify(error),
  });
};
