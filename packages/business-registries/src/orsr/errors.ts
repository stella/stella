import { RegistryError } from "../shared/errors.js";

export class OrsrError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OrsrError";
  }
}

export class OrsrAPIError extends OrsrError {
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
    this.name = "OrsrAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
  }
}

export class OrsrValidationError extends OrsrError {
  constructor(message: string) {
    super(message);
    this.name = "OrsrValidationError";
  }
}

export class OrsrRequestError extends OrsrError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OrsrRequestError";
    this.url = url;
  }
}
