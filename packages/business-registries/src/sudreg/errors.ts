import { RegistryError } from "../shared/errors.js";

export class SudregError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SudregError";
  }
}

export class SudregAPIError extends SudregError {
  readonly httpStatus: number;

  constructor({
    cause,
    message,
    httpStatus,
  }: {
    cause?: unknown;
    message: string;
    httpStatus: number;
  }) {
    super(message, { cause });
    this.name = "SudregAPIError";
    this.httpStatus = httpStatus;
  }
}

export class SudregParseError extends SudregError {
  constructor(message: string) {
    super(message);
    this.name = "SudregParseError";
  }
}

export class SudregValidationError extends SudregError {
  constructor(message: string) {
    super(message);
    this.name = "SudregValidationError";
  }
}

export class SudregRequestError extends SudregError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SudregRequestError";
    this.url = url;
  }
}
