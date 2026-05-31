import { RegistryError } from "../shared/errors.js";

export class RechercheEntreprisesError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RechercheEntreprisesError";
  }
}

export class RechercheEntreprisesAPIError extends RechercheEntreprisesError {
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
    this.name = "RechercheEntreprisesAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
  }
}

export class RechercheEntreprisesValidationError extends RechercheEntreprisesError {
  constructor(message: string) {
    super(message);
    this.name = "RechercheEntreprisesValidationError";
  }
}

export class RechercheEntreprisesRequestError extends RechercheEntreprisesError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RechercheEntreprisesRequestError";
    this.url = url;
  }
}
