import { RegistryError } from "../shared/errors.js";

const BRREG_REGISTRY_SLUG = "no-brreg";

export class BrregError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrregError";
  }
}

export class BrregAPIError extends BrregError {
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
    this.name = "BrregAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
  }
}

export class BrregNotFoundError extends BrregError {
  readonly orgnr: string;
  readonly canonicalId: string;
  readonly registrySlug: string = BRREG_REGISTRY_SLUG;

  constructor(orgnr: string) {
    super(`Norwegian entity not found: ${orgnr}`);
    this.name = "BrregNotFoundError";
    this.orgnr = orgnr;
    // Also expose as canonicalId so the shared `isEntityNotFound`
    // predicate picks this up alongside `error instanceof BrregError`.
    this.canonicalId = orgnr;
  }
}

export class BrregTooBroadError extends BrregError {
  constructor(query: string) {
    super(`Search too broad: ${query}`);
    this.name = "BrregTooBroadError";
  }
}

export class BrregValidationError extends BrregError {
  constructor(message: string) {
    super(message);
    this.name = "BrregValidationError";
  }
}

export class BrregRequestError extends BrregError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrregRequestError";
    this.url = url;
  }
}
