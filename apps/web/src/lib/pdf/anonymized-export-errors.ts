import { TaggedError } from "better-result";

export class UnsupportedAnonymizedExportError extends TaggedError(
  "UnsupportedAnonymizedExportError",
)<{ message: string }> {}
