import { RegistryError } from "../shared/errors.js";

export class GcisError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GcisError";
  }
}

export class GcisAPIError extends GcisError {
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
    this.name = "GcisAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
  }
}

export class GcisValidationError extends GcisError {
  constructor(message: string) {
    super(message);
    this.name = "GcisValidationError";
  }
}

export class GcisRequestError extends GcisError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GcisRequestError";
    this.url = url;
  }
}
