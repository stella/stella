// Shared tagged-error hierarchy for every business-registry adapter.
//
// Per-adapter errors (e.g. AresError, BrregError) extend `RegistryError`
// or one of its specialised subclasses so downstream consumers can branch
// on registry-agnostic failure modes without importing adapter-internal
// types.

export class RegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryError";
  }
}

export class RegistryUnavailableError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryUnavailableError";
  }
}

export class EntityNotFoundError extends RegistryError {
  readonly canonicalId: string;
  readonly registrySlug: string;

  constructor({
    canonicalId,
    registrySlug,
    message,
    cause,
  }: {
    canonicalId: string;
    registrySlug: string;
    message: string;
    cause?: unknown;
  }) {
    super(message, { cause });
    this.name = "EntityNotFoundError";
    this.canonicalId = canonicalId;
    this.registrySlug = registrySlug;
  }
}

export class RegistryRateLimitedError extends RegistryError {
  readonly retryAfterMs: number | null;

  constructor({
    message,
    retryAfterMs,
    cause,
  }: {
    message: string;
    retryAfterMs?: number | null;
    cause?: unknown;
  }) {
    super(message, { cause });
    this.name = "RegistryRateLimitedError";
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

export class RegistryAuthRequiredError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryAuthRequiredError";
  }
}

export class RegistryDataPaywalledError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryDataPaywalledError";
  }
}

export class RegistryLicenceIncompatibleError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryLicenceIncompatibleError";
  }
}
