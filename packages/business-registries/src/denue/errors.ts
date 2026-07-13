import { RegistryError } from "../shared/errors.js";

export class DenueError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DenueError";
  }
}

export class DenueAPIError extends DenueError {
  readonly httpStatus: number;
  readonly upstreamMessage: string | null;

  constructor({
    cause,
    message,
    httpStatus,
    upstreamMessage,
  }: {
    cause?: unknown;
    message: string;
    httpStatus: number;
    upstreamMessage?: string | null;
  }) {
    super(message, { cause });
    this.name = "DenueAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
  }
}

export class DenueAuthError extends DenueError {
  constructor(message: string) {
    super(message);
    this.name = "DenueAuthError";
  }
}

export class DenueValidationError extends DenueError {
  constructor(message: string) {
    super(message);
    this.name = "DenueValidationError";
  }
}

export class DenueRequestError extends DenueError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DenueRequestError";
    this.url = url;
  }
}
