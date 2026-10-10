// Verification also runs before dependency installation, so errors use built-ins.
export class VerifyError extends Error {
  readonly _tag = "VerifyError";

  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}
