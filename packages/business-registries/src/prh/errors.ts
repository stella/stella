import { RegistryError } from "../shared/errors.js";

export class PrhError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrhError";
  }
}

export class PrhAPIError extends PrhError {
  readonly httpStatus: number;
  readonly upstreamMessage: string | null;
  readonly upstreamCode: number | null;

  constructor({
    cause,
    message,
    httpStatus,
    upstreamMessage,
    upstreamCode,
  }: {
    cause?: unknown;
    message: string;
    httpStatus: number;
    upstreamMessage?: string | null;
    upstreamCode?: number | null;
  }) {
    super(message, { cause });
    this.name = "PrhAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
    this.upstreamCode = upstreamCode ?? null;
  }
}

export class PrhValidationError extends PrhError {
  constructor(message: string) {
    super(message);
    this.name = "PrhValidationError";
  }
}

export class PrhRequestError extends PrhError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrhRequestError";
    this.url = url;
  }
}
