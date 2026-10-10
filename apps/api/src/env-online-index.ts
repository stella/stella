import * as v from "valibot";

import { defaultConfig, validateConfig } from "@stll/db-load-gate/health";
import type { HealthConfig } from "@stll/db-load-gate/health";

const integer = (fallback: number, minimum = 1) =>
  v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.safeInteger(),
      v.minValue(minimum),
    ),
    String(fallback),
  );

/** Online index runner settings, cataloged with the API environment. */
export const envOnlineIndexServerSchema = {
  DB_LOAD_GATE_START_FLOOR: integer(defaultConfig.startFloor, 0),
  DB_LOAD_GATE_HARD_FLOOR: integer(defaultConfig.hardFloor, 0),
  DB_LOAD_GATE_MAX_STALENESS_MS: integer(defaultConfig.maxStalenessMs),
  DB_LOAD_GATE_READ_TIMEOUT_MS: integer(defaultConfig.readTimeoutMs),
  DB_LOAD_GATE_MAX_HELD_MS: integer(defaultConfig.maxHeldMs),
  DB_LOAD_GATE_LONG_TX_MAX_AGE_MS: integer(defaultConfig.longTxMaxAgeMs),
  DB_LOAD_GATE_BUSY_WINDOWS: v.optional(
    v.pipe(
      v.string(),
      v.parseJson(),
      v.array(
        v.strictObject({
          start: v.string(),
          end: v.string(),
          timeZone: v.string(),
        }),
      ),
    ),
    JSON.stringify(defaultConfig.busyWindows),
  ),
  ONLINE_INDEX_POLL_MS: integer(30_000),
  ONLINE_INDEX_CLIENT_CHECK_MS: integer(1000),
  ONLINE_INDEX_RETRY_MS: integer(defaultConfig.holdBackoffMs),
  ONLINE_INDEX_MAX_SNAPSHOT_WAIT_MS: integer(10 * 60_000),
  ONLINE_INDEX_PARALLEL_WORKERS: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(0),
      v.maxValue(1),
    ),
    "1",
  ),
  ONLINE_INDEX_MAINTENANCE_WORK_MEM_MB: integer(64),
};

const schema = v.object(envOnlineIndexServerSchema);

export type OnlineIndexConfig = {
  health: HealthConfig;
  pollMs: number;
  clientConnectionCheckMs: number;
  retryMs: number;
  maxSnapshotWaitMs: number;
  parallelWorkers: number;
  maintenanceWorkMemMb: number;
};

export const readOnlineIndexConfig = (
  environment: Record<string, string | undefined> = process.env,
): OnlineIndexConfig => {
  const env = v.parse(schema, environment);
  const health = {
    ...defaultConfig,
    startFloor: env.DB_LOAD_GATE_START_FLOOR,
    hardFloor: env.DB_LOAD_GATE_HARD_FLOOR,
    maxStalenessMs: env.DB_LOAD_GATE_MAX_STALENESS_MS,
    readTimeoutMs: env.DB_LOAD_GATE_READ_TIMEOUT_MS,
    longTxMaxAgeMs: env.DB_LOAD_GATE_LONG_TX_MAX_AGE_MS,
    maxHeldMs: env.DB_LOAD_GATE_MAX_HELD_MS,
    busyWindows: env.DB_LOAD_GATE_BUSY_WINDOWS,
  };
  validateConfig(health);
  return {
    health,
    pollMs: env.ONLINE_INDEX_POLL_MS,
    clientConnectionCheckMs: env.ONLINE_INDEX_CLIENT_CHECK_MS,
    retryMs: env.ONLINE_INDEX_RETRY_MS,
    maxSnapshotWaitMs: env.ONLINE_INDEX_MAX_SNAPSHOT_WAIT_MS,
    parallelWorkers: env.ONLINE_INDEX_PARALLEL_WORKERS,
    maintenanceWorkMemMb: env.ONLINE_INDEX_MAINTENANCE_WORK_MEM_MB,
  };
};
