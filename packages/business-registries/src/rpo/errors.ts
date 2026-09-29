import { RegistryError } from "../shared/errors.js";

export class RpoError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpoError";
  }
}

export class RpoAPIError extends RpoError {
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
    this.name = "RpoAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
  }
}

export class RpoValidationError extends RpoError {
  constructor(message: string) {
    super(message);
    this.name = "RpoValidationError";
  }
}

export class RpoRequestError extends RpoError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpoRequestError";
    this.url = url;
  }
}
