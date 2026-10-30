/**
 * Soft-law publishers expose listings only: no count endpoint and no
 * exhaustive date-slice interface. `reason` states why for this publisher.
 */
export const listingOnlyCoverage = (reason: string) => ({
  getTotalCount: async () =>
    await Promise.resolve({ type: "no-count-endpoint" as const }),
  sliceWalk: { type: "unsupported" as const, reason },
});
