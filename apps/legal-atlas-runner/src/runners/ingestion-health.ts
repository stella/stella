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
