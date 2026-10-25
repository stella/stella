import { TaggedError } from "better-result";
import type { Result } from "better-result";

export const SOFT_LAW_BLOCK_REASONS = [
  "forbidden",
  "rate_limited",
  "challenge",
] as const;
export type SoftLawBlockReason = (typeof SOFT_LAW_BLOCK_REASONS)[number];
export type SoftLawResponse = { bytes: Uint8Array; contentType: string };
export class SoftLawBlockedError extends TaggedError("SoftLawBlockedError")<{
  message: string;
  reason: SoftLawBlockReason;
}> {}
export class SoftLawAccessError extends TaggedError("SoftLawAccessError")<{
  message: string;
  cause?: unknown;
}> {}
export class SoftLawContentTypeMismatchError extends TaggedError(
  "SoftLawContentTypeMismatchError",
)<{
  message: string;
  contentType: string;
}> {}
export type SoftLawFetchError =
  | SoftLawBlockedError
  | SoftLawAccessError
  | SoftLawContentTypeMismatchError;
export type SoftLawFetch = ((
  url: string,
  options?: { expectedContentTypes: readonly string[] },
) => Promise<Result<SoftLawResponse, SoftLawFetchError>>) & {
  readonly getBlockReason: () => SoftLawBlockReason | null;
  readonly getWindowState: () => "open" | "deferred_window";
  readonly getLeaseState: () => "active" | "lost";
};
