import { Result } from "better-result";

export const INGESTION_HEALTH_MESSAGE = "case_law.ingestion.heartbeat";

type IngestionHealthRecordOptions = {
  uptimeSec: number;
  pagesSinceStart: number;
  activeCycles: number;
  stalledAdapters: ReadonlySet<string>;
};

/**
 * The periodic state CloudWatch reads for both liveness and stalled-source
 * alarms. A gauge keeps the alarm aligned with the current episode: sparse
 * error pulses can age out while the source is still stalled.
 */
export const ingestionHealthRecord = ({
  uptimeSec,
  pagesSinceStart,
  activeCycles,
  stalledAdapters,
}: IngestionHealthRecordOptions) => ({
  message: INGESTION_HEALTH_MESSAGE,
  uptimeSec,
  pagesSinceStart,
  activeCycles,
  stalledAdapterCount: stalledAdapters.size,
  stalledAdapters: [...stalledAdapters].toSorted().join(",") || "none",
});

const STORED_TOTAL_HEARTBEAT_INTERVAL_MS = 60_000;

type IngestionHealthRefreshOptions = {
  clock: () => number;
  emitStoredTotalHeartbeat: () => Promise<void>;
  refreshCredentials: () => Promise<void>;
  warnHeartbeatFailure: (error: unknown) => void;
};

/** A failed telemetry read must neither hot-loop nor starve credential refresh. */
export const createIngestionHealthRefresh = ({
  clock,
  emitStoredTotalHeartbeat,
  refreshCredentials,
  warnHeartbeatFailure,
}: IngestionHealthRefreshOptions) => {
  let nextStoredTotalHeartbeatAt = 0;
  let warningStatus: "unreported" | "reported" = "unreported";
  return async () => {
    const now = clock();
    if (now >= nextStoredTotalHeartbeatAt) {
      // Advance before reading: failures use the same cadence as successes.
      nextStoredTotalHeartbeatAt = now + STORED_TOTAL_HEARTBEAT_INTERVAL_MS;
      const heartbeat = await Result.tryPromise({
        try: emitStoredTotalHeartbeat,
        catch: (error) => error,
      });
      if (heartbeat.isErr() && warningStatus === "unreported") {
        warningStatus = "reported";
        warnHeartbeatFailure(heartbeat.error);
      }
    }
    await refreshCredentials();
  };
};
