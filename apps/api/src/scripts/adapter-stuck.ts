import { encodePlNsaCursor } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-cursor";
import { PL_NSA_SNAPSHOT } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

export const SOURCE_SYNC_PROGRESS = {
  COMPLETE: "complete",
  ONGOING: "ongoing",
} as const;

type SourceSyncProgressOptions = {
  adapterKey: string;
  syncCursor: string | null;
};

export const sourceSyncProgress = ({
  adapterKey,
  syncCursor,
}: SourceSyncProgressOptions) =>
  adapterKey === ADAPTER_KEYS.PL_NSA &&
  syncCursor ===
    encodePlNsaCursor(
      { shard: PL_NSA_SNAPSHOT.shards.length, row: 0 },
      PL_NSA_SNAPSHOT,
    )
    ? SOURCE_SYNC_PROGRESS.COMPLETE
    : SOURCE_SYNC_PROGRESS.ONGOING;

/** Adapter is "stuck" if no growth in this many hours. */
const STUCK_THRESHOLD_HOURS = 12;

/** Issue prefix for stuck detection (used in summary counts). */
export const STUCK_PREFIX = "Stuck:" as const;

type StuckSyncRead = {
  enabled: boolean;
  progress: ReturnType<typeof sourceSyncProgress>;
  /** Hours since the publisher last answered a sync; null before the first. */
  hoursSinceSync: number | null;
};

/**
 * The stuck issue for a source, or null. Only a live publisher can fall
 * behind: a fixed snapshot read to its end asks nothing, so a long silence is
 * its finished state, not a stall.
 */
export const stuckSyncIssue = ({
  progress,
  enabled,
  hoursSinceSync,
}: StuckSyncRead): string | null => {
  if (
    !enabled ||
    progress === SOURCE_SYNC_PROGRESS.COMPLETE ||
    hoursSinceSync === null ||
    hoursSinceSync <= STUCK_THRESHOLD_HOURS
  ) {
    return null;
  }
  return `${STUCK_PREFIX} no sync in ${Math.round(hoursSinceSync)}h`;
};
