import { panic, Result } from "better-result";

import { isFreshReading } from "./health";
import type { HealthConfig, Signal } from "./health";

export type EbsBalanceReading = {
  byteBalancePct: number;
  ioBalancePct: number;
  observedAt: string;
};
export type IndicatorClock = () => number;
export type IndicatorTimeout = (milliseconds: number) => {
  expired: Promise<void>;
  cancel: () => void;
};
type ReaderOptions<T> = {
  read: () => Promise<T | null>;
  now: IndicatorClock;
  config: HealthConfig;
  timeout?: IndicatorTimeout;
};

const timeoutAfter: IndicatorTimeout = (milliseconds) => {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return { expired, cancel: () => clearTimeout(timer) };
};

const readBounded = async <T>({
  read,
  config,
  timeout = timeoutAfter,
}: ReaderOptions<T>) => {
  const outcome = await Result.tryPromise(async () => {
    const timer = timeout(config.readTimeoutMs);
    const reading = await Result.tryPromise(
      async () =>
        await Promise.race([
          Promise.resolve().then(read),
          timer.expired.then(() => null),
        ]),
    );
    timer.cancel();
    return Result.isOk(reading) ? reading.value : null;
  });
  return Result.isOk(outcome) ? outcome.value : null;
};

const unknown = (indicator: Signal["indicator"], reason: string): Signal => ({
  indicator,
  kind: "unknown",
  value: null,
  threshold: null,
  observedAt: null,
  reason,
});
const fresh = (
  observedAt: string,
  now: IndicatorClock,
  config: HealthConfig,
) => {
  const clock = Result.try(now);
  return (
    Result.isOk(clock) &&
    isFreshReading(observedAt, clock.value, config.maxStalenessMs)
  );
};

export const ebsBalance = async (
  options: ReaderOptions<EbsBalanceReading>,
): Promise<Signal> => {
  const reading = await readBounded(options);
  if (
    reading === null ||
    !fresh(reading.observedAt, options.now, options.config)
  ) {
    return unknown(
      "ebs_balance",
      "Missing, failed, timed out, or stale balance reading",
    );
  }
  if (
    ![reading.byteBalancePct, reading.ioBalancePct].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 100,
    )
  ) {
    return unknown("ebs_balance", "Invalid balance reading");
  }
  const value = Math.min(reading.byteBalancePct, reading.ioBalancePct);
  const { hardFloor, startFloor } = options.config;
  let kind: Signal["kind"] = "normal";
  if (value < startFloor) {
    kind = "degraded";
  }
  if (value < hardFloor) {
    kind = "stop";
  }
  return {
    indicator: "ebs_balance",
    kind,
    value,
    threshold: kind === "stop" ? hardFloor : startFloor,
    observedAt: reading.observedAt,
    reason: "Minimum byte and IO balance",
  };
};

export type LongTransactionReading = { ageMs: number; observedAt: string };
export const longTransaction = async (
  options: ReaderOptions<LongTransactionReading>,
): Promise<Signal> => {
  const reading = await readBounded(options);
  if (
    reading === null ||
    !fresh(reading.observedAt, options.now, options.config) ||
    !Number.isFinite(reading.ageMs) ||
    reading.ageMs < 0
  ) {
    return unknown(
      "long_transaction",
      "Missing, failed, timed out, or stale transaction reading",
    );
  }
  return {
    indicator: "long_transaction",
    kind: reading.ageMs > options.config.longTxMaxAgeMs ? "stop" : "normal",
    value: reading.ageMs,
    threshold: options.config.longTxMaxAgeMs,
    observedAt: reading.observedAt,
    reason: "Oldest scoped transaction age",
  };
};

export type AutovacuumReading = { active: boolean; observedAt: string };
type AutovacuumOptions = ReaderOptions<AutovacuumReading> & {
  kind: "index_build" | "backfill_batch";
};
export const autovacuumOnTarget = async (
  options: AutovacuumOptions,
): Promise<Signal> => {
  const reading = await readBounded(options);
  if (
    reading === null ||
    !fresh(reading.observedAt, options.now, options.config) ||
    typeof reading.active !== "boolean"
  ) {
    return unknown(
      "autovacuum_on_target",
      "Missing, failed, timed out, or stale autovacuum reading",
    );
  }
  const activeKind = options.kind === "index_build" ? "stop" : "degraded";
  return {
    indicator: "autovacuum_on_target",
    kind: reading.active ? activeKind : "normal",
    value: reading.active ? 1 : 0,
    threshold: 0,
    observedAt: reading.observedAt,
    reason: "Autovacuum on target",
  };
};

/** Table scope uses relation locks; database scope also catches unrelated snapshots. */
export const LONG_TRANSACTION_SQL = `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (clock_timestamp() - a.xact_start)) * 1000), 0)::double precision AS "ageMs", clock_timestamp()::text AS "observedAt"
FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
AND a.xact_start IS NOT NULL AND (a.backend_type <> 'autovacuum worker' OR a.state IS DISTINCT FROM 'idle')
AND ($1::text = 'database' OR EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.relation = to_regclass($2::text) AND l.granted))`;

// Progress supplies the relation identity, avoiding fragile query-text matching.
export const AUTOVACUUM_SQL = `SELECT EXISTS (SELECT 1 FROM (SELECT pid, datid, relid FROM pg_stat_progress_vacuum UNION ALL SELECT pid, datid, relid FROM pg_stat_progress_analyze) v JOIN pg_stat_activity a USING (pid)
WHERE v.datid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND v.relid = to_regclass($1::text)
AND a.backend_type = 'autovacuum worker') AS active, clock_timestamp()::text AS "observedAt"`;

type BusyWindowOptions = { now: IndicatorClock; config: HealthConfig };
export const busyWindow = ({ now, config }: BusyWindowOptions): Signal => {
  const clock = Result.try(now);
  if (
    Result.isError(clock) ||
    !Number.isFinite(clock.value) ||
    !Number.isFinite(new Date(clock.value).getTime())
  ) {
    return unknown("busy_window", "Invalid clock");
  }
  const instant = clock.value;
  const result = Result.try(() =>
    config.busyWindows.some(({ start, end, timeZone }) => {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(instant);
      const hour =
        parts.find(({ type }) => type === "hour")?.value ??
        panic("Busy-window formatter omitted the hour");
      const minute =
        parts.find(({ type }) => type === "minute")?.value ??
        panic("Busy-window formatter omitted the minute");
      const local = `${hour}:${minute}`;
      return start <= end
        ? local >= start && local < end
        : local >= start || local < end;
    }),
  );
  if (Result.isError(result)) {
    return unknown("busy_window", "Invalid busy window configuration");
  }
  return {
    indicator: "busy_window",
    kind: result.value ? "stop" : "normal",
    value: result.value ? 1 : 0,
    threshold: 0,
    observedAt: new Date(instant).toISOString(),
    reason: "Configured local busy window",
  };
};
