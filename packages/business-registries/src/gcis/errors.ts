import { RegistryError } from "../shared/errors.js";

const GCIS_REGISTRY_SLUG = "tw-gcis";

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

export class GcisNotFoundError extends GcisError {
  readonly taxId: string;
  readonly canonicalId: string;
  readonly registrySlug: string = GCIS_REGISTRY_SLUG;

  constructor(taxId: string) {
    super(`Taiwanese entity not found: ${taxId}`);
    this.name = "GcisNotFoundError";
    this.taxId = taxId;
    // Mirror the field so the shared `isEntityNotFound` predicate
    // detects GCIS not-found alongside `instanceof GcisError`.
    this.canonicalId = taxId;
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
