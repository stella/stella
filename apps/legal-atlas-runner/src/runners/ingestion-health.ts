import {
  INGESTION_STOP_KIND,
  type IngestionStopKind,
} from "@/api/lib/legal-search/ingestion-stop-kind";

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
  const counts = {
    sourceUnreachableCount: 0,
    publisherRefusalCount: 0,
    adapterStuckCount: 0,
    deadlineCount: 0,
  } satisfies Record<(typeof STOP_KIND_COUNT_FIELD)[IngestionStopKind], number>;
  for (const stopKind of stalledAdapters.values()) {
    counts[STOP_KIND_COUNT_FIELD[stopKind]]++;
  }
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
