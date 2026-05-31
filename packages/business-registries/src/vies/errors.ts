import { RegistryError } from "../shared/errors.js";

// Note: no `ViesNotFoundError`. VIES does not distinguish "not on file"
// from a bad-format input via 404; both come back as HTTP 200 with a
// `userError` discriminator in the body. The dispatch layer surfaces
// the unregistered case via `ViesValidation.valid === false`, not as
// an `isEntityNotFound` error.

export class ViesError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ViesError";
  }
}

export class ViesAPIError extends ViesError {
  readonly httpStatus: number;
  readonly upstreamUserError: string | null;

  constructor({
    cause,
    message,
    httpStatus,
    upstreamUserError,
  }: {
    cause?: unknown;
    message: string;
    httpStatus: number;
    upstreamUserError?: string | null;
  }) {
    super(message, { cause });
    this.name = "ViesAPIError";
    this.httpStatus = httpStatus;
    this.upstreamUserError = upstreamUserError ?? null;
  }
}

export class ViesValidationError extends ViesError {
  constructor(message: string) {
    super(message);
    this.name = "ViesValidationError";
  }
}

export class ViesRequestError extends ViesError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ViesRequestError";
    this.url = url;
  }
}
