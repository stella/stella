export class BoeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BoeError";
  }
}

export class BoeAPIError extends BoeError {
  readonly httpStatus: number;
  readonly boeStatus: string | null;

  constructor({
    cause,
    message,
    httpStatus,
    boeStatus,
  }: {
    cause?: unknown;
    message: string;
    httpStatus: number;
    boeStatus?: string | null;
  }) {
    super(message, { cause });
    this.name = "BoeAPIError";
    this.httpStatus = httpStatus;
    this.boeStatus = boeStatus ?? null;
  }
}

export class BoeNotFoundError extends BoeError {
  readonly resource: string;

  constructor(resource: string) {
    super(`BOE resource not found: ${resource}`);
    this.name = "BoeNotFoundError";
    this.resource = resource;
  }
}

export class BoeValidationError extends BoeError {
  constructor(message: string) {
    super(message);
    this.name = "BoeValidationError";
  }
}

export class BoeRequestError extends BoeError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BoeRequestError";
    this.url = url;
  }
}
