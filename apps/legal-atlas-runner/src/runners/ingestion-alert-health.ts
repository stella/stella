import {
  INGESTION_STOP_DISPOSITION,
  type IngestionStopKind,
} from "@stll/legal-atlas/ingestion-cycle";
import { DAY_IN_MS } from "@stll/time";

import {
  INITIAL_STALL_ALERT,
  type CycleResult,
  type StallAlertState,
  cycleMadeProgress,
  cycleStopKind,
  stepAdapterCycleHealth,
} from "./cycle-progress";
import { ingestionHealthRecord } from "./ingestion-health";

/** Elapsed source unavailability threshold for the sustained health gauge. */
export const SOURCE_UNAVAILABLE_AFTER_MS = DAY_IN_MS;

type AlertEpisode = { captureStatus: "unreported" | "reported" } & (
  | { type: "defect"; stall: StallAlertState }
  | { type: "source_unavailable"; stall: StallAlertState; sinceMs: number }
);

type IngestionAlertHealthOptions = {
  now: () => number;
  stallThreshold: number;
  sourceUnavailableAfterMs: number;
};

/** Owns both exception eligibility and the gauge consumed by the paging alarm. */
export const createIngestionAlertHealth = ({
  now,
  stallThreshold,
  sourceUnavailableAfterMs,
}: IngestionAlertHealthOptions) => {
  const episodes = new Map<string, AlertEpisode>();
  const stalledAdapters = new Map<string, IngestionStopKind>();

  const step = (adapterKey: string, cycle: CycleResult) => {
    const stopKind = cycleStopKind(cycle);
    const disposition = INGESTION_STOP_DISPOSITION[stopKind];
    const previous = episodes.get(adapterKey);
    // Every no-progress turn contributes, regardless of cause. Source outage
    // thresholds do not consume the separate once-per-episode defect capture.
    const stallAlert = previous?.stall ?? INITIAL_STALL_ALERT;
    const result = stepAdapterCycleHealth({
      adapterKey,
      cycle,
      stallAlert,
      stalledAdapters,
      threshold: stallThreshold,
    });
    const madeProgress = cycleMadeProgress(cycle);
    const capture =
      !madeProgress &&
      disposition === "defect" &&
      result.stall.state.captured &&
      previous?.captureStatus !== "reported";
    const captureStatus = capture
      ? "reported"
      : (previous?.captureStatus ?? "unreported");
    if (madeProgress) {
      episodes.delete(adapterKey);
    } else if (disposition === "source_unavailable") {
      episodes.set(adapterKey, {
        type: "source_unavailable",
        captureStatus,
        stall: result.stall.state,
        sinceMs:
          previous?.type === "source_unavailable" ? previous.sinceMs : now(),
      });
    } else {
      episodes.set(adapterKey, {
        type: "defect",
        captureStatus,
        stall: result.stall.state,
      });
    }
    return {
      disposition,
      stopKind,
      stall: {
        ...result.stall,
        sustained: result.stall.sustained ?? (capture ? stallThreshold : null),
        capture,
      },
    };
  };

  type HealthRecordOptions = {
    uptimeSec: number;
    pagesSinceStart: number;
    activeCycles: number;
  };

  const record = (options: HealthRecordOptions) => {
    const observedAt = now();
    let sourceUnavailableCount = 0;
    let sustainedSourceUnavailableCount = 0;
    let defectCount = 0;
    const sourceUnavailableAgeMs = new Map<string, number>();
    const stalledAdapterHealth = new Map<string, AlertEpisode["type"]>();
    for (const [adapterKey, episode] of episodes) {
      if (episode.type === "source_unavailable") {
        sourceUnavailableCount++;
        const ageMs = Math.max(0, observedAt - episode.sinceMs);
        sourceUnavailableAgeMs.set(adapterKey, ageMs);
        if (ageMs >= sourceUnavailableAfterMs && episode.stall.captured) {
          sustainedSourceUnavailableCount++;
        }
      } else if (episode.stall.captured) {
        defectCount++;
      }
      stalledAdapterHealth.set(adapterKey, episode.type);
    }
    const health = ingestionHealthRecord({ ...options, stalledAdapters });
    return {
      ...health,
      // Existing alarms already read this gauge. Source outages enter it only
      // after the elapsed threshold, never through exception capture.
      stalledAdapterCount: defectCount + sustainedSourceUnavailableCount,
      stalledAdapterTotalCount: health.stalledAdapterCount,
      stalledAdapterHealth: Object.fromEntries(stalledAdapterHealth),
      sourceUnavailableCount,
      sustainedSourceUnavailableCount,
      sourceUnavailableAgeMs: Object.fromEntries(sourceUnavailableAgeMs),
      sourceUnavailableAfterMs,
    };
  };

  return { step, record };
};
