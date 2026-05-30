import { EntityNotFoundError, RegistryError } from "../shared/errors.js";

const ARES_REGISTRY_SLUG = "cz-ares";

export class AresError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AresError";
  }
}

export class AresAPIError extends AresError {
  readonly httpStatus: number;
  readonly aresCode: string | null;
  readonly aresDescription: string | null;

  constructor({
    cause,
    message,
    httpStatus,
    aresCode,
    aresDescription,
  }: {
    cause?: unknown;
    message: string;
    httpStatus: number;
    aresCode?: string | null;
    aresDescription?: string | null;
  }) {
    super(message, { cause });
    this.name = "AresAPIError";
    this.httpStatus = httpStatus;
    this.aresCode = aresCode ?? null;
    this.aresDescription = aresDescription ?? null;
  }
}

export class AresNotFoundError extends EntityNotFoundError {
  readonly ico: string;

  constructor(ico: string) {
    super({
      canonicalId: ico,
      registrySlug: ARES_REGISTRY_SLUG,
      message: `Economic subject not found: ${ico}`,
    });
    this.name = "AresNotFoundError";
    this.ico = ico;
  }
}

export class AresTooBroadError extends AresError {
  constructor(query: string) {
    super(`Search too broad: ${query}`);
    this.name = "AresTooBroadError";
  }
}

export class AresValidationError extends AresError {
  constructor(message: string) {
    super(message);
    this.name = "AresValidationError";
  }
}

export class AresRequestError extends AresError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AresRequestError";
    this.url = url;
  }
}
