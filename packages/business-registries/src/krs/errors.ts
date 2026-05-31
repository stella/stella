import { RegistryError } from "../shared/errors.js";

const KRS_REGISTRY_SLUG = "pl-krs";

export class KrsError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KrsError";
  }
}

export class KrsAPIError extends KrsError {
  readonly httpStatus: number;
  readonly upstreamTitle: string | null;
  readonly upstreamDetail: string | null;

  constructor({
    cause,
    message,
    httpStatus,
    upstreamTitle,
    upstreamDetail,
  }: {
    cause?: unknown;
    message: string;
    httpStatus: number;
    upstreamTitle?: string | null;
    upstreamDetail?: string | null;
  }) {
    super(message, { cause });
    this.name = "KrsAPIError";
    this.httpStatus = httpStatus;
    this.upstreamTitle = upstreamTitle ?? null;
    this.upstreamDetail = upstreamDetail ?? null;
  }
}

export class KrsNotFoundError extends KrsError {
  readonly krsNumber: string;
  readonly canonicalId: string;
  readonly registrySlug: string = KRS_REGISTRY_SLUG;

  constructor(krsNumber: string) {
    super(`Polish entity not found: ${krsNumber}`);
    this.name = "KrsNotFoundError";
    this.krsNumber = krsNumber;
    // Mirror the field so the shared `isEntityNotFound` predicate
    // detects KRS not-found alongside `instanceof KrsError`.
    this.canonicalId = krsNumber;
  }
}

export class KrsValidationError extends KrsError {
  constructor(message: string) {
    super(message);
    this.name = "KrsValidationError";
  }
}

export class KrsRequestError extends KrsError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KrsRequestError";
    this.url = url;
  }
}
