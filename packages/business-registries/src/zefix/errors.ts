import { RegistryError } from "../shared/errors.js";

export class ZefixError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZefixError";
  }
}

export class ZefixAPIError extends ZefixError {
  readonly httpStatus: number;
  readonly upstreamCode: string | null;

  constructor({
    cause,
    message,
    httpStatus,
    upstreamCode,
  }: {
    cause?: unknown;
    message: string;
    httpStatus: number;
    upstreamCode?: string | null;
  }) {
    super(message, { cause });
    this.name = "ZefixAPIError";
    this.httpStatus = httpStatus;
    this.upstreamCode = upstreamCode ?? null;
  }
}

export class ZefixValidationError extends ZefixError {
  constructor(message: string) {
    super(message);
    this.name = "ZefixValidationError";
  }
}

export class ZefixRequestError extends ZefixError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZefixRequestError";
    this.url = url;
  }
}
