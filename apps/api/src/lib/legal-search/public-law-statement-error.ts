import { TaggedError } from "better-result";

/** A statement executed through the observed public-law transaction. */
export class PublicLawStatementError extends TaggedError(
  "PublicLawStatementError",
)<{
  message: string;
  cause: unknown;
}> {}
