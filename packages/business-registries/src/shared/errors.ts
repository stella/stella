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

// Not-found is intentionally NOT a class. JavaScript single inheritance
// means a per-adapter class can extend either its adapter base
// (AresError / BrregError, preserving `error instanceof AresError`
// checks across consumers) OR a shared NotFound base — not both. The
// adapter chain is the older, established expectation; the structural
// type + predicate below give the shared layer the cross-adapter
// detection it needs without forcing adapter classes off their base.
//
// Per-adapter NotFound classes declare `readonly canonicalId: string`
// and `readonly registrySlug: string` to satisfy this contract.
export type EntityNotFound = RegistryError & {
  readonly canonicalId: string;
  readonly registrySlug: string;
};

export const isEntityNotFound = (error: unknown): error is EntityNotFound => {
  if (!(error instanceof RegistryError)) {
    return false;
  }
  const maybe = error as Partial<EntityNotFound>;
  return (
    typeof maybe.canonicalId === "string" &&
    typeof maybe.registrySlug === "string"
  );
};

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
