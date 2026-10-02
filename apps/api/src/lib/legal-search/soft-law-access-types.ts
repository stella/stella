export const SOFT_LAW_BLOCK_REASONS = [
  "forbidden",
  "rate_limited",
  "challenge",
] as const;
export type SoftLawBlockReason = (typeof SOFT_LAW_BLOCK_REASONS)[number];
export type SoftLawResponse = { bytes: Uint8Array; contentType: string };
export type SoftLawFetch = ((
  url: string,
  options?: { expectedContentTypes: readonly string[] },
) => Promise<SoftLawResponse>) & {
  readonly getBlockReason: () => SoftLawBlockReason | null;
  readonly getWindowState: () => "open" | "deferred_window";
  readonly getLeaseState: () => "active" | "lost";
};
