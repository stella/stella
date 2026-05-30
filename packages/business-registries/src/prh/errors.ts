import { RegistryError } from "../shared/errors.js";

const PRH_REGISTRY_SLUG = "fi-prh";

export class PrhError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrhError";
  }
}

export class PrhAPIError extends PrhError {
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
    this.name = "PrhAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
    this.upstreamCode = upstreamCode ?? null;
  }
}

export class PrhNotFoundError extends PrhError {
  readonly businessId: string;
  readonly canonicalId: string;
  readonly registrySlug: string = PRH_REGISTRY_SLUG;

  constructor(businessId: string) {
    super(`Finnish entity not found: ${businessId}`);
    this.name = "PrhNotFoundError";
    this.businessId = businessId;
    // Mirror the field so the shared `isEntityNotFound` predicate
    // detects PRH not-found alongside `instanceof PrhError`.
    this.canonicalId = businessId;
  }
}

export class PrhValidationError extends PrhError {
  constructor(message: string) {
    super(message);
    this.name = "PrhValidationError";
  }
}

export class PrhRequestError extends PrhError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrhRequestError";
    this.url = url;
  }
}
