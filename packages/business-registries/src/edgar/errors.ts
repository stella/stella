import { RegistryError } from "../shared/errors.js";

const EDGAR_REGISTRY_SLUG = "us-edgar";

export class EdgarError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EdgarError";
  }
}

export class EdgarAPIError extends EdgarError {
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
    this.name = "EdgarAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
  }
}

export class EdgarNotFoundError extends EdgarError {
  readonly cik: string;
  readonly canonicalId: string;
  readonly registrySlug: string = EDGAR_REGISTRY_SLUG;

  constructor(cik: string) {
    super(`SEC EDGAR entity not found: ${cik}`);
    this.name = "EdgarNotFoundError";
    this.cik = cik;
    // Surfaced as canonicalId (zero-padded 10-digit) so the shared
    // `isEntityNotFound` predicate detects this alongside
    // `error instanceof EdgarError`.
    this.canonicalId = cik;
  }
}

export class EdgarValidationError extends EdgarError {
  constructor(message: string) {
    super(message);
    this.name = "EdgarValidationError";
  }
}

export class EdgarRequestError extends EdgarError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EdgarRequestError";
    this.url = url;
  }
}
