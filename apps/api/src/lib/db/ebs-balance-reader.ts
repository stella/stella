import {
  CloudWatchClient,
  GetMetricDataCommand,
  type GetMetricDataCommandOutput,
  type MetricDataResult,
} from "@aws-sdk/client-cloudwatch";
import { Result, TaggedError } from "better-result";

import { defaultConfig } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

export class EbsBalanceReadError extends TaggedError("EbsBalanceReadError")<{
  message: string;
  cause?: unknown;
}> {}

type MetricClient = {
  send: (
    command: GetMetricDataCommand,
    options: { abortSignal: AbortSignal },
  ) => Promise<GetMetricDataCommandOutput>;
};

type EbsBalanceReaderOptions = {
  instanceIdentifier: string;
  client?: MetricClient;
  clock?: () => number;
  timeoutMs?: number;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
  maxStalenessMs?: number;
};

const METRICS = {
  byte_balance: "EBSByteBalance%",
  io_balance: "EBSIOBalance%",
} as const;
const PERIOD_SECONDS = 300;

const newestPoint = (result: MetricDataResult | undefined) => {
  if (
    result === undefined ||
    result.StatusCode !== "Complete" ||
    result.Timestamps === undefined
  ) {
    return Result.err(
      new EbsBalanceReadError({
        message: "EBS metric response is incomplete",
      }),
    );
  }
  let newest: { value: number; timestamp: number } | undefined;
  for (const [index, timestamp] of result.Timestamps.entries()) {
    const value = result.Values?.at(index);
    const time = timestamp.getTime();
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100 ||
      !Number.isFinite(time)
    ) {
      return Result.err(
        new EbsBalanceReadError({
          message: "EBS metric datapoint is invalid",
        }),
      );
    }
    if (newest === undefined || time > newest.timestamp) {
      newest = { value, timestamp: time };
    }
  }
  if (newest === undefined) {
    return Result.err(
      new EbsBalanceReadError({ message: "EBS metric has no datapoints" }),
    );
  }
  return Result.ok(newest);
};

/** Region and credentials use the SDK provider chain; freshness belongs to the gate. */
export const createEbsBalanceReader = ({
  instanceIdentifier,
  client: injectedClient,
  clock = () => Temporal.Now.instant().epochMilliseconds,
  timeoutMs = defaultConfig.readTimeoutMs,
  timeoutSignal = AbortSignal.timeout,
  maxStalenessMs = defaultConfig.maxStalenessMs,
}: EbsBalanceReaderOptions) => {
  let client = injectedClient;
  return async () => {
    if (instanceIdentifier.trim() === "") {
      return Result.err(
        new EbsBalanceReadError({
          message: "An RDS instance identifier is required for EBS metrics",
        }),
      );
    }
    const request = await Result.tryPromise({
      try: async () => {
        client ??= new CloudWatchClient({});
        const now = clock();
        return await client.send(
          new GetMetricDataCommand({
            StartTime: new Date(now - maxStalenessMs - PERIOD_SECONDS * 1000),
            EndTime: new Date(now),
            ScanBy: "TimestampDescending",
            MetricDataQueries: Object.entries(METRICS).map(
              ([Id, MetricName]) => ({
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
                  Period: PERIOD_SECONDS,
                  Stat: "Minimum",
                },
              }),
            ),
          }),
          { abortSignal: timeoutSignal(timeoutMs) },
        );
      },
      catch: (cause) =>
        new EbsBalanceReadError({
          message: "EBS metric request failed",
          cause,
        }),
    });
    if (request.isErr()) {return request;}
    const response = request.value;
    const byte = newestPoint(
      response.MetricDataResults?.find(({ Id }) => Id === "byte_balance"),
    );
    if (byte.isErr()) {return byte;}
    const io = newestPoint(
      response.MetricDataResults?.find(({ Id }) => Id === "io_balance"),
    );
    if (io.isErr()) {return io;}
    return Result.ok({
      byteBalancePct: byte.value.value,
      ioBalancePct: io.value.value,
      // Using the older timestamp prevents one fresh metric from hiding a stale partner.
      observedAt: new Date(
        Math.min(byte.value.timestamp, io.value.timestamp),
      ).toISOString(),
    });
  };
};
