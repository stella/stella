import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { panic, Result, TaggedError } from "better-result";

import { logger } from "@/api/lib/observability/logger";

/**
 * Optional pacing for the corpus-index build loop.
 *
 * When the `CORPUS_INDEX_BACKPRESSURE_*` env group is configured, the loop
 * samples one CloudWatch metric and pauses while the value sits below the
 * low watermark, resuming once it climbs back above the high watermark.
 * The gap between the watermarks is hysteresis: a value oscillating around
 * a single threshold cannot flap the loop between states.
 *
 * Sampling is best-effort by design: a CloudWatch failure keeps the last
 * known state (initially running) rather than stopping the build. The
 * pacer also emits a periodic progress heartbeat through the structured
 * logger, whether or not backpressure is configured, so an external
 * watcher can distinguish a slow build from a dead one.
 */

export class BackpressureSampleError extends TaggedError(
  "BackpressureSampleError",
)<{
  message: string;
  cause?: unknown;
}> {}

export type BackpressureDimension = { name: string; value: string };

export type BackpressureConfig = {
  metric: string;
  namespace: string;
  dimensions: BackpressureDimension[];
  lowWatermark: number;
  highWatermark: number;
  sampleIntervalMs: number;
};

type BackpressureEnv = {
  CORPUS_INDEX_BACKPRESSURE_METRIC?: string | undefined;
  CORPUS_INDEX_BACKPRESSURE_NAMESPACE?: string | undefined;
  CORPUS_INDEX_BACKPRESSURE_DIMENSIONS?: string | undefined;
  CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK: number;
  CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK: number;
  CORPUS_INDEX_BACKPRESSURE_SAMPLE_INTERVAL_MS: number;
};

/** `Name=Value[,Name=Value...]`; the format is checked by the env schema. */
export const parseBackpressureDimensions = (
  spec: string | undefined,
): BackpressureDimension[] => {
  if (spec === undefined || spec.length === 0) {
    return [];
  }
  return spec.split(",").map((pair) => {
    const separator = pair.indexOf("=");
    if (separator <= 0 || separator === pair.length - 1) {
      panic(`Malformed backpressure dimension: ${pair}`);
    }
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1) };
  });
};

/**
 * Null when the env group is absent (pacing disabled). The pairing and
 * watermark-order invariants are enforced at env validation, so a
 * half-configured group cannot reach this resolver.
 */
export const resolveBackpressureConfig = (
  env: BackpressureEnv,
): BackpressureConfig | null => {
  const metric = env.CORPUS_INDEX_BACKPRESSURE_METRIC;
  const namespace = env.CORPUS_INDEX_BACKPRESSURE_NAMESPACE;
  if (metric === undefined && namespace === undefined) {
    return null;
  }
  if (metric === undefined || namespace === undefined) {
    panic(
      "backpressure metric and namespace must be configured together (enforced by env validation)",
    );
  }
  return {
    metric,
    namespace,
    dimensions: parseBackpressureDimensions(
      env.CORPUS_INDEX_BACKPRESSURE_DIMENSIONS,
    ),
    lowWatermark: env.CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK,
    highWatermark: env.CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK,
    sampleIntervalMs: env.CORPUS_INDEX_BACKPRESSURE_SAMPLE_INTERVAL_MS,
  };
};

export const BACKFILL_PACING_STATE = {
  paused: "paused",
  running: "running",
} as const;

export type BackfillPacingState =
  (typeof BACKFILL_PACING_STATE)[keyof typeof BACKFILL_PACING_STATE];

export type PacingWatermarks = Pick<
  BackpressureConfig,
  "highWatermark" | "lowWatermark"
>;

type NextPacingStateOptions = {
  current: BackfillPacingState;
  sample: number;
  watermarks: PacingWatermarks;
};

/**
 * Hysteresis step: below the low watermark is always paused, above the
 * high watermark always running, and the band between keeps the current
 * state.
 */
export const nextPacingState = ({
  current,
  sample,
  watermarks,
}: NextPacingStateOptions): BackfillPacingState => {
  if (sample < watermarks.lowWatermark) {
    return BACKFILL_PACING_STATE.paused;
  }
  if (sample > watermarks.highWatermark) {
    return BACKFILL_PACING_STATE.running;
  }
  return current;
};

/** Latest metric value, or null when the lookback window holds none. */
export type BackpressureSampler = () => Promise<
  Result<number | null, BackpressureSampleError>
>;

const SAMPLE_LOOKBACK_MS = 10 * 60_000;
const SAMPLE_PERIOD_S = 60;
const SAMPLE_TIMEOUT_MS = 10_000;

/**
 * Samples the configured metric's most recent datapoint. Region and
 * credentials come from the default AWS provider chain; nothing about the
 * metric's origin is known here beyond what the env group states.
 */
export const createCloudWatchBackpressureSampler = (
  config: BackpressureConfig,
): BackpressureSampler => {
  let client: CloudWatchClient | null = null;
  return async () =>
    await Result.tryPromise({
      try: async () => {
        client ??= new CloudWatchClient({});
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - SAMPLE_LOOKBACK_MS);
        const response = await client.send(
          new GetMetricDataCommand({
            StartTime: startTime,
            EndTime: endTime,
            ScanBy: "TimestampDescending",
            MetricDataQueries: [
              {
                Id: "backpressure",
                ReturnData: true,
                MetricStat: {
                  Metric: {
                    MetricName: config.metric,
                    Namespace: config.namespace,
                    Dimensions: config.dimensions.map(({ name, value }) => ({
                      Name: name,
                      Value: value,
                    })),
                  },
                  Period: SAMPLE_PERIOD_S,
                  Stat: "Average",
                },
              },
            ],
          }),
          { abortSignal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS) },
        );
        const value = response.MetricDataResults?.at(0)?.Values?.at(0);
        return typeof value === "number" ? value : null;
      },
      catch: (cause) =>
        new BackpressureSampleError({
          message: "backpressure metric sample failed",
          cause,
        }),
    });
};

const HEARTBEAT_INTERVAL_MS = 60_000;

type PacerLog = Pick<typeof logger, "info" | "warn">;

type CreateBackfillPacerOptions = {
  generation: string;
  backpressure: {
    config: BackpressureConfig;
    sample: BackpressureSampler;
  } | null;
  heartbeatIntervalMs?: number;
  log?: PacerLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type BackfillPacer = {
  /** Waits out any active pause; call before each batch. */
  beforeBatch: () => Promise<void>;
  recordBatch: (indexed: number) => void;
  /** Emits the final heartbeat with cumulative totals. */
  finish: () => void;
};

export const createBackfillPacer = ({
  backpressure,
  generation,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  log = logger,
  now = Date.now,
  sleep = async (ms) => {
    await Bun.sleep(ms);
  },
}: CreateBackfillPacerOptions): BackfillPacer => {
  let state: BackfillPacingState = BACKFILL_PACING_STATE.running;
  let lastSampleAt: number | null = null;
  let lastSampleValue: number | null = null;
  let totalIndexed = 0;
  let batches = 0;
  let windowIndexed = 0;
  let windowStartedAt = now();
  // Null so the first beforeBatch emits immediately: the heartbeat is the
  // loop's liveness signal, so it must exist before the first batch does.
  let lastHeartbeatAt: number | null = null;

  const emitHeartbeat = (at: number): void => {
    const windowSeconds = (at - windowStartedAt) / 1000;
    log.info("case_law.corpus_index.backfill_heartbeat", {
      generation,
      state,
      totalIndexed,
      batches,
      windowIndexed,
      docsPerSecond:
        windowSeconds > 0
          ? Number((windowIndexed / windowSeconds).toFixed(2))
          : 0,
      backpressureConfigured: backpressure !== null,
      ...(lastSampleValue === null ? {} : { sampleValue: lastSampleValue }),
    });
    lastHeartbeatAt = at;
    windowStartedAt = at;
    windowIndexed = 0;
  };

  const maybeHeartbeat = (): void => {
    const at = now();
    if (
      lastHeartbeatAt !== null &&
      at - lastHeartbeatAt < heartbeatIntervalMs
    ) {
      return;
    }
    emitHeartbeat(at);
  };

  const maybeSample = async (): Promise<void> => {
    if (backpressure === null) {
      return;
    }
    const at = now();
    if (
      lastSampleAt !== null &&
      at - lastSampleAt < backpressure.config.sampleIntervalMs
    ) {
      return;
    }
    lastSampleAt = at;
    const sampled = await backpressure.sample();
    if (Result.isError(sampled)) {
      // Best-effort: pacing must never stop the build, so a failed sample
      // keeps the last known state (initially running).
      log.warn("case_law.corpus_index.backpressure_sample_failed", {
        generation,
        state,
        errorTag: sampled.error._tag,
      });
      return;
    }
    if (sampled.value === null) {
      // No datapoints in the lookback window: nothing to act on.
      return;
    }
    lastSampleValue = sampled.value;
    const next = nextPacingState({
      current: state,
      sample: sampled.value,
      watermarks: backpressure.config,
    });
    if (next === state) {
      return;
    }
    state = next;
    log.info(
      next === BACKFILL_PACING_STATE.paused
        ? "case_law.corpus_index.backfill_paused"
        : "case_law.corpus_index.backfill_resumed",
      {
        generation,
        sampleValue: sampled.value,
        lowWatermark: backpressure.config.lowWatermark,
        highWatermark: backpressure.config.highWatermark,
      },
    );
  };

  const pauseStep = async (): Promise<void> => {
    if (backpressure === null) {
      panic("corpus backfill paused without backpressure configuration");
    }
    maybeHeartbeat();
    // The heartbeat must keep its cadence through a pause, so the wait
    // never exceeds either interval; resampling stays throttled to the
    // sample interval by maybeSample itself.
    await sleep(
      Math.min(backpressure.config.sampleIntervalMs, heartbeatIntervalMs),
    );
    await maybeSample();
  };

  return {
    beforeBatch: async () => {
      await maybeSample();
      while (state === BACKFILL_PACING_STATE.paused) {
        await pauseStep();
      }
      maybeHeartbeat();
    },
    recordBatch: (indexed) => {
      totalIndexed += indexed;
      windowIndexed += indexed;
      batches += 1;
    },
    finish: () => {
      emitHeartbeat(now());
    },
  };
};
