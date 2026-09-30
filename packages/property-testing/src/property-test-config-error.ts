// A malformed property-test environment variable. A local class keeps this
// package free of runtime dependencies beyond fast-check.
export class PropertyTestConfigError extends Error {
  readonly _tag = "PropertyTestConfigError";

  constructor(message: string) {
    super(message);
    this.name = "PropertyTestConfigError";
  }
}
