import {
  CloudWatchClient,
  GetMetricDataCommand,
  type GetMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import {
  GetResourceMetricsCommand,
  type GetResourceMetricsCommandOutput,
  PIClient,
} from "@aws-sdk/client-pi";
import {
  DescribeDBInstancesCommand,
  type DescribeDBInstancesCommandOutput,
  RDSClient,
} from "@aws-sdk/client-rds";
import { panic, Result } from "better-result";

import type { HealthConfig, Signal } from "@stll/db-load-gate/health";
import {
  DATABASE_PRESSURE_SQL,
  pressureSignal,
} from "@stll/db-load-gate/indicators";

import type { IndicatorQuery } from "@/api/db/indicator-query";
import { isRecord } from "@/api/lib/type-guards";

import type { EbsConfiguration } from "./ebs-signal-reader";

const HOST_METRICS = {
  cpu_percent: {
    cloudWatch: "CPUUtilization",
    pi: "os.cpuUtilization.total.avg",
    multiplier: 1,
  },
  read_iops: {
    cloudWatch: "ReadIOPS",
    pi: "os.diskIO.rdsdev.readIOsPS.avg",
    multiplier: 1,
  },
  write_iops: {
    cloudWatch: "WriteIOPS",
    pi: "os.diskIO.rdsdev.writeIOsPS.avg",
    multiplier: 1,
  },
  read_bytes_per_second: {
    cloudWatch: "ReadThroughput",
    pi: "os.diskIO.rdsdev.readKbPS.avg",
    multiplier: 1024,
  },
  write_bytes_per_second: {
    cloudWatch: "WriteThroughput",
    pi: "os.diskIO.rdsdev.writeKbPS.avg",
    multiplier: 1024,
  },
} as const;
type HostIndicator = keyof typeof HOST_METRICS;
export type HostPressureSnapshot = Record<HostIndicator, number> & {
  observedAt: string;
};

type HostSource = { type: "pi"; resourceId: string } | { type: "cloudwatch" };
type ProviderOptions = {
  instanceIdentifier: string;
  clock: () => number;
  timeoutMs: number;
  clients?: {
    rds: {
      send: (
        command: DescribeDBInstancesCommand,
        options: { abortSignal: AbortSignal },
      ) => Promise<DescribeDBInstancesCommandOutput>;
    };
    pi: {
      send: (
        command: GetResourceMetricsCommand,
        options: { abortSignal: AbortSignal },
      ) => Promise<GetResourceMetricsCommandOutput>;
    };
    cloudwatch: {
      send: (
        command: GetMetricDataCommand,
        options: { abortSignal: AbortSignal },
      ) => Promise<GetMetricDataCommandOutput>;
    };
  };
};

type PressurePoints = Map<HostIndicator, { value: number; timestamp: number }>;
const parsePiPressure = (response: GetResourceMetricsCommandOutput) => {
  const values: PressurePoints = new Map();
  for (const [indicator, metric] of Object.entries(HOST_METRICS)) {
    const points = response.MetricList?.find(
      ({ Key }) => Key?.Metric === metric.pi,
    )?.DataPoints;
    const point = points
      ?.filter(
        ({ Timestamp, Value }) =>
          Timestamp !== undefined && Value !== undefined,
      )
      .toSorted(
        (a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0),
      )
      .at(0);
    if (
      point?.Timestamp !== undefined &&
      point.Value !== undefined &&
      isHostIndicator(indicator)
    ) {
      values.set(indicator, {
        value: point.Value * metric.multiplier,
        timestamp: point.Timestamp.getTime(),
      });
    }
  }
  return values;
};
const parseCloudWatchPressure = (response: GetMetricDataCommandOutput) => {
  const values: PressurePoints = new Map();
  for (const result of response.MetricDataResults ?? []) {
    if (
      result.Id === undefined ||
      !isHostIndicator(result.Id) ||
      result.StatusCode !== "Complete"
    ) {
      continue;
    }
    for (const [index, stamp] of (result.Timestamps ?? []).entries()) {
      const value = result.Values?.at(index);
      const existing = values.get(result.Id);
      if (
        value !== undefined &&
        (existing === undefined || stamp.getTime() > existing.timestamp)
      ) {
        values.set(result.Id, { value, timestamp: stamp.getTime() });
      }
    }
  }
  return values;
};

/** Discovery is read-only; no call can enable PI, Enhanced Monitoring or paid retention. */
export const createHostPressureProvider = ({
  instanceIdentifier,
  clock,
  timeoutMs,
  clients,
}: ProviderOptions) => {
  let source: HostSource | undefined;
  let sourceObservedAt: number | undefined;
  let rds = clients?.rds;
  let pi = clients?.pi;
  let cloudwatch = clients?.cloudwatch;
  return async (): Promise<HostPressureSnapshot | null> => {
    const abortSignal = AbortSignal.timeout(timeoutMs);
    const outcome = await Result.tryPromise(async () => {
      if (
        source === undefined ||
        sourceObservedAt === undefined ||
        clock() - sourceObservedAt >= 10 * 60_000
      ) {
        rds ??= new RDSClient({ maxAttempts: 1 });
        const response = await rds.send(
          new DescribeDBInstancesCommand({
            DBInstanceIdentifier: instanceIdentifier,
          }),
          { abortSignal },
        );
        const instance = response.DBInstances?.at(0);
        if (
          instance === undefined ||
          instance.DBInstanceIdentifier !== instanceIdentifier
        ) {
          return null;
        }
        sourceObservedAt = clock();
        source =
          instance.PerformanceInsightsEnabled === true &&
          instance.PerformanceInsightsRetentionPeriod === 7 &&
          instance.DatabaseInsightsMode !== "advanced" &&
          instance.DbiResourceId !== undefined
            ? { type: "pi", resourceId: instance.DbiResourceId }
            : { type: "cloudwatch" };
      }
      const now = clock();
      const start = new Date(now - 15 * 60_000);
      const end = new Date(now);
      let values: PressurePoints;
      switch (source.type) {
        case "pi": {
          pi ??= new PIClient({ maxAttempts: 1 });
          const response = await pi.send(
            new GetResourceMetricsCommand({
              ServiceType: "RDS",
              Identifier: source.resourceId,
              StartTime: start,
              EndTime: end,
              PeriodInSeconds: 60,
              MetricQueries: Object.values(HOST_METRICS).map(
                ({ pi: Metric }) => ({ Metric }),
              ),
            }),
            { abortSignal },
          );
          values = parsePiPressure(response);
          break;
        }
        case "cloudwatch": {
          cloudwatch ??= new CloudWatchClient({ maxAttempts: 1 });
          const response = await cloudwatch.send(
            new GetMetricDataCommand({
              StartTime: start,
              EndTime: end,
              ScanBy: "TimestampDescending",
              MetricDataQueries: Object.entries(HOST_METRICS).map(
                ([Id, { cloudWatch: MetricName }]) => ({
                  Id,
                  ReturnData: true,
                  MetricStat: {
                    Metric: {
                      Namespace: "AWS/RDS",
                      MetricName,
                      Dimensions: [
                        {
                          Name: "DBInstanceIdentifier",
                          Value: instanceIdentifier,
                        },
                      ],
                    },
                    Period: 60,
                    Stat: "Maximum",
                  },
                }),
              ),
            }),
            { abortSignal },
          );
          values = parseCloudWatchPressure(response);
          break;
        }
        default:
          source satisfies never;
          return panic("Unhandled host pressure source");
      }
      const cpu = values.get("cpu_percent");
      const read = values.get("read_iops");
      const write = values.get("write_iops");
      const readBytes = values.get("read_bytes_per_second");
      const writeBytes = values.get("write_bytes_per_second");
      if (
        cpu === undefined ||
        read === undefined ||
        write === undefined ||
        readBytes === undefined ||
        writeBytes === undefined
      ) {
        return null;
      }
      return {
        cpu_percent: cpu.value,
        read_iops: read.value,
        write_iops: write.value,
        read_bytes_per_second: readBytes.value,
        write_bytes_per_second: writeBytes.value,
        observedAt: new Date(
          Math.min(
            cpu.timestamp,
            read.timestamp,
            write.timestamp,
            readBytes.timestamp,
            writeBytes.timestamp,
          ),
        ).toISOString(),
      };
    });
    return outcome.isOk() ? outcome.value : null;
  };
};
const isHostIndicator = (value: string): value is HostIndicator =>
  Object.hasOwn(HOST_METRICS, value);

const parseHostSnapshot = (value: unknown): HostPressureSnapshot | null => {
  if (
    !isRecord(value) ||
    typeof value["observedAt"] !== "string" ||
    typeof value["cpu_percent"] !== "number" ||
    typeof value["read_iops"] !== "number" ||
    typeof value["write_iops"] !== "number" ||
    typeof value["read_bytes_per_second"] !== "number" ||
    typeof value["write_bytes_per_second"] !== "number"
  ) {
    return null;
  }
  return {
    cpu_percent: value["cpu_percent"],
    read_iops: value["read_iops"],
    write_iops: value["write_iops"],
    read_bytes_per_second: value["read_bytes_per_second"],
    write_bytes_per_second: value["write_bytes_per_second"],
    observedAt: value["observedAt"],
  };
};

type PressureReaderOptions = {
  query: IndicatorQuery;
  configuration: EbsConfiguration;
  clock: () => number;
  config: HealthConfig;
  readHost?: () => Promise<HostPressureSnapshot | null>;
};

/** Shared database admission caps the five paid metrics at 144 requests/day across the fleet. */
export const createPressureReader = ({
  query,
  configuration,
  clock,
  config,
  readHost: injectedReadHost,
}: PressureReaderOptions) => {
  let provider: ReturnType<typeof createHostPressureProvider> | undefined;
  let inFlight: Promise<Signal[]> | undefined;
  let cached: { at: number; signals: Signal[] } | undefined;
  const read = async (): Promise<Signal[]> => {
    const raw = await Result.tryPromise(async () =>
      (await query(DATABASE_PRESSURE_SQL)).at(0),
    );
    const database = raw.isOk() && isRecord(raw.value) ? raw.value : null;
    const dbSignals = await Promise.all(
      ["active_sessions", "replication_lag_ms"].map(async (indicator) => {
        if (
          indicator !== "active_sessions" &&
          indicator !== "replication_lag_ms"
        ) {
          return [];
        }
        const value = database?.[indicator];
        const observedAt = database?.["observedAt"];
        return [
          await pressureSignal({
            indicator,
            now: clock,
            config,
            read: async () =>
              typeof value === "number" && typeof observedAt === "string"
                ? { value, observedAt }
                : null,
          }),
        ];
      }),
    );
    let snapshot: HostPressureSnapshot | null = null;
    switch (configuration.type) {
      case "enabled": {
        const result = await Result.tryPromise(async () => {
          const token = Bun.randomUUIDv7();
          const claimed = (
            await query(
              "SELECT claimed, snapshot FROM public.stella_database_pressure_cache_claim($1, $2)",
              [configuration.instanceIdentifier, token],
            )
          ).at(0);
          if (!isRecord(claimed)) {
            return null;
          }
          const previous = parseHostSnapshot(claimed["snapshot"]);
          if (claimed["claimed"] !== true) {
            return previous;
          }
          provider ??= createHostPressureProvider({
            instanceIdentifier: configuration.instanceIdentifier,
            clock,
            timeoutMs: config.readTimeoutMs,
          });
          const next = await (injectedReadHost ?? provider)();
          if (next === null) {
            return previous;
          }
          await query(
            "SELECT public.stella_database_pressure_cache_publish($1, $2, $3::text::jsonb)",
            [configuration.instanceIdentifier, token, JSON.stringify(next)],
          );
          return next;
        });
        snapshot = result.isOk() ? result.value : null;
        break;
      }
      case "disabled":
        return dbSignals.flat().concat(
          Object.keys(HOST_METRICS)
            .filter(isHostIndicator)
            .map((indicator): Signal => ({
              indicator,
              kind: "not_configured",
              value: null,
              threshold: null,
              observedAt: null,
              reason:
                "Host pressure explicitly disabled for non-RDS maintenance",
            })),
        );
      case "missing":
        break;
      default:
        configuration satisfies never;
        return panic("Unhandled pressure configuration");
    }
    const hostSignals = await Promise.all(
      Object.keys(HOST_METRICS)
        .filter(isHostIndicator)
        .map(
          async (indicator) =>
            await pressureSignal({
              indicator,
              now: clock,
              config,
              read: async () =>
                snapshot === null
                  ? null
                  : {
                      value: snapshot[indicator],
                      observedAt: snapshot.observedAt,
                    },
            }),
        ),
    );
    return dbSignals.flat().concat(hostSignals);
  };
  return async () => {
    if (inFlight !== undefined) {
      return await inFlight;
    }
    const now = clock();
    if (cached !== undefined && now >= cached.at && now - cached.at < 1000) {
      return cached.signals;
    }
    inFlight = read();
    try {
      const signals = await inFlight;
      cached = { at: now, signals };
      return signals;
    } finally {
      inFlight = undefined;
    }
  };
};
