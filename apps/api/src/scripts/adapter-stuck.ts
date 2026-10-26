import type { AdapterEdition } from "@/api/lib/legal-search/adapter-manifest";

/** Adapter is "stuck" if no growth in this many hours. */
const STUCK_THRESHOLD_HOURS = 12;

/** Issue prefix for stuck detection (used in summary counts). */
export const STUCK_PREFIX = "Stuck:" as const;

type StuckSyncRead = {
  enabled: boolean;
  /** The adapter's declared edition; null for a key no manifest names. */
  edition: AdapterEdition | null;
  /** Hours since the publisher last answered a sync; null before the first. */
  hoursSinceSync: number | null;
};

/**
 * The stuck issue for a source, or null. Only a live publisher can fall
 * behind: a fixed snapshot read to its end asks nothing, so a long silence is
 * its finished state, not a stall.
 */
export const stuckSyncIssue = ({
  edition,
  enabled,
  hoursSinceSync,
}: StuckSyncRead): string | null => {
  if (
    !enabled ||
    edition?.type === "snapshot" ||
    hoursSinceSync === null ||
    hoursSinceSync <= STUCK_THRESHOLD_HOURS
  ) {
    return null;
  }
  return `${STUCK_PREFIX} no sync in ${Math.round(hoursSinceSync)}h`;
};
