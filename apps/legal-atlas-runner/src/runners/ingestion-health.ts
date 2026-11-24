import { Result } from "better-result";

import {
  INGESTION_STOP_KIND,
  type IngestionStopKind,
} from "@stll/legal-atlas/ingestion-cycle";

export const INGESTION_HEALTH_MESSAGE = "case_law.ingestion.heartbeat";

type IngestionHealthRecordOptions = {
  uptimeSec: number;
  pagesSinceStart: number;
  activeCycles: number;
  stalledAdapters: ReadonlyMap<string, IngestionStopKind>;
};

const STOP_KIND_COUNT_FIELD = {
  [INGESTION_STOP_KIND.SOURCE_UNREACHABLE]: "sourceUnreachableCount",
  [INGESTION_STOP_KIND.PUBLISHER_REFUSAL]: "publisherRefusalCount",
  [INGESTION_STOP_KIND.ADAPTER_ERROR]: "adapterStuckCount",
  [INGESTION_STOP_KIND.DEADLINE]: "deadlineCount",
  [INGESTION_STOP_KIND.INTERNAL_ERROR]: "internalErrorCount",
} as const satisfies Record<IngestionStopKind, string>;

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
}: IngestionHealthRecordOptions) => {
  const countMap = new Map<
    (typeof STOP_KIND_COUNT_FIELD)[IngestionStopKind],
    number
  >([
    ["sourceUnreachableCount", 0],
    ["publisherRefusalCount", 0],
    ["adapterStuckCount", 0],
    ["deadlineCount", 0],
    ["internalErrorCount", 0],
  ]);
  for (const stopKind of stalledAdapters.values()) {
    const field = STOP_KIND_COUNT_FIELD[stopKind];
    countMap.set(field, (countMap.get(field) ?? 0) + 1);
  }
  const counts = {
    sourceUnreachableCount: countMap.get("sourceUnreachableCount") ?? 0,
    publisherRefusalCount: countMap.get("publisherRefusalCount") ?? 0,
    adapterStuckCount: countMap.get("adapterStuckCount") ?? 0,
    deadlineCount: countMap.get("deadlineCount") ?? 0,
    internalErrorCount: countMap.get("internalErrorCount") ?? 0,
  } satisfies Record<(typeof STOP_KIND_COUNT_FIELD)[IngestionStopKind], number>;
  return {
    message: INGESTION_HEALTH_MESSAGE,
    uptimeSec,
    pagesSinceStart,
    activeCycles,
    stalledAdapterCount: stalledAdapters.size,
    stalledAdapters: [...stalledAdapters.keys()].toSorted().join(",") || "none",
    stalledAdapterStopKinds: Object.fromEntries(stalledAdapters),
    ...counts,
  };
};

const STORED_TOTAL_HEARTBEAT_INTERVAL_MS = 60_000;

type IngestionHealthRefreshOptions = {
  clock: () => number;
  emitStoredTotalHeartbeat: () => Promise<void>;
  refreshCredentials: () => Promise<void>;
  observeHeartbeatFailure: (error: unknown) => void;
};

/**
 * A failed or slow telemetry read must neither hot-loop nor starve credential
 * refresh: the read runs in the background, one at a time, so the caller's
 * loop keeps its own cadence however long the read takes.
 */
export const createIngestionHealthRefresh = ({
  clock,
  emitStoredTotalHeartbeat,
  refreshCredentials,
  observeHeartbeatFailure,
}: IngestionHealthRefreshOptions) => {
  let nextStoredTotalHeartbeatAt = 0;
  let warningStatus: "unreported" | "reported" = "unreported";
  let inFlight: Promise<void> | undefined;
  const emitOnce = async () => {
    const heartbeat = await Result.tryPromise({
      try: emitStoredTotalHeartbeat,
      catch: (error) => error,
    });
    // One observation per failure episode: a success ends the episode, so
    // a later outage is reported again.
    if (heartbeat.isOk()) {
      warningStatus = "unreported";
    } else if (warningStatus === "unreported") {
      warningStatus = "reported";
      observeHeartbeatFailure(heartbeat.error);
    }
  };
  const refresh = async () => {
    const now = clock();
    if (inFlight === undefined && now >= nextStoredTotalHeartbeatAt) {
      // Advance before reading: failures use the same cadence as successes.
      nextStoredTotalHeartbeatAt = now + STORED_TOTAL_HEARTBEAT_INTERVAL_MS;
      inFlight = emitOnce()
        // A throwing observer must not surface as an unhandled rejection.
        .catch(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });
    }
    await refreshCredentials();
  };
  /** Settles once the background read, if any, has finished. */
  const idle = async () => {
    await inFlight;
  };
  return Object.assign(refresh, { idle });
};
