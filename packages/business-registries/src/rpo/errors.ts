import { RegistryError } from "../shared/errors.js";

const RPO_REGISTRY_SLUG = "sk-rpo";

export class RpoError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpoError";
  }
}

export class RpoAPIError extends RpoError {
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
    this.name = "RpoAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
    this.upstreamCode = upstreamCode ?? null;
  }
}

export class RpoNotFoundError extends RpoError {
  readonly ico: string;
  readonly canonicalId: string;
  readonly registrySlug: string = RPO_REGISTRY_SLUG;

  constructor(ico: string) {
    super(`Slovak entity not found: ${ico}`);
    this.name = "RpoNotFoundError";
    this.ico = ico;
    // Mirror the field so the shared `isEntityNotFound` predicate
    // detects RPO not-found alongside `instanceof RpoError`.
    this.canonicalId = ico;
  }
}

export class RpoValidationError extends RpoError {
  constructor(message: string) {
    super(message);
    this.name = "RpoValidationError";
  }
}

export class RpoRequestError extends RpoError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpoRequestError";
    this.url = url;
  }
}
