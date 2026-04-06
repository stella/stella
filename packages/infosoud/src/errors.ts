export class InfoSoudError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InfoSoudError";
  }
}

export class InfoSoudAPIError extends InfoSoudError {
  readonly path: string;
  readonly responseBody: unknown;
  readonly status: number;

  constructor({
    cause,
    message,
    path,
    responseBody,
    status,
  }: {
    cause?: unknown;
    message: string;
    path: string;
    responseBody: unknown;
    status: number;
  }) {
    super(message, { cause });
    this.name = "InfoSoudAPIError";
    this.path = path;
    this.responseBody = responseBody;
    this.status = status;
  }
}

export class InfoSoudParseError extends InfoSoudError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InfoSoudParseError";
  }
}

export class InfoSoudRequestError extends InfoSoudError {
  readonly path: string;

  constructor(path: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InfoSoudRequestError";
    this.path = path;
  }
}
