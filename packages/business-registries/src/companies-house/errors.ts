import { RegistryError } from "../shared/errors.js";

const COMPANIES_HOUSE_REGISTRY_SLUG = "gb-companies-house";

export class CompaniesHouseError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompaniesHouseError";
  }
}

export class CompaniesHouseAPIError extends CompaniesHouseError {
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
    this.name = "CompaniesHouseAPIError";
    this.httpStatus = httpStatus;
    this.upstreamMessage = upstreamMessage ?? null;
  }
}

export class CompaniesHouseAuthError extends CompaniesHouseError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompaniesHouseAuthError";
  }
}

export class CompaniesHouseNotFoundError extends CompaniesHouseError {
  readonly companyNumber: string;
  readonly canonicalId: string;
  readonly registrySlug: string = COMPANIES_HOUSE_REGISTRY_SLUG;

  constructor(companyNumber: string) {
    super(`UK Companies House entity not found: ${companyNumber}`);
    this.name = "CompaniesHouseNotFoundError";
    this.companyNumber = companyNumber;
    // Surfaced as canonicalId (8-char company number) so the shared
    // `isEntityNotFound` predicate picks this up alongside
    // `error instanceof CompaniesHouseError`.
    this.canonicalId = companyNumber;
  }
}

export class CompaniesHouseValidationError extends CompaniesHouseError {
  constructor(message: string) {
    super(message);
    this.name = "CompaniesHouseValidationError";
  }
}

export class CompaniesHouseRequestError extends CompaniesHouseError {
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompaniesHouseRequestError";
    this.url = url;
  }
}
