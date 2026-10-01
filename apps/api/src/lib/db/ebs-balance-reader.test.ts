import type {
  GetMetricDataCommand,
  GetMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import { describe, expect, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";
import { ebsBalance } from "@stll/db-load-gate/indicators";

import {
  createEbsBalanceReader,
  EbsBalanceReadError,
} from "./ebs-balance-reader";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const response = (
  byteTime = NOW,
  ioTime = NOW,
): GetMetricDataCommandOutput => ({
  $metadata: {},
  MetricDataResults: [
    {
      Id: "io_balance",
      StatusCode: "Complete",
      Values: [85],
      Timestamps: [new Date(ioTime)],
    },
    {
      Id: "byte_balance",
      StatusCode: "Complete",
      Values: [75],
      Timestamps: [new Date(byteTime)],
    },
  ],
});

describe("the shared RDS EBS reader", () => {
  test("the reader deadline aborts a pending SDK request and blocks the gate", async () => {
    const deadline = new AbortController();
    const requestedTimeouts: number[] = [];
    let requestAborted = false;
    const started = Promise.withResolvers<undefined>();
    const timeoutMs = 123;
    const readResult = createEbsBalanceReader({
      instanceIdentifier: "test-instance",
      clock: () => NOW,
      timeoutMs,
      timeoutSignal: (duration) => {
        requestedTimeouts.push(duration);
        return deadline.signal;
      },
      client: {
        send: (_command, { abortSignal }) =>
          new Promise<GetMetricDataCommandOutput>((_resolve, reject) => {
            abortSignal.addEventListener(
              "abort",
              () => {
                requestAborted = true;
                reject(
                  new EbsBalanceReadError({ message: "SDK request aborted" }),
                );
              },
              { once: true },
            );
            started.resolve(undefined);
          }),
      },
    });
    const read = async () => {
      const outcome = await readResult();
      return outcome.isOk() ? outcome.value : null;
    };
    const reading = ebsBalance({ read, now: () => NOW, config: defaultConfig });
    await started.promise;
    expect(requestAborted).toBe(false);
    deadline.abort();
    // Check transport cleanup before awaiting the gate's separate timeout;
    // a logical unknown alone does not prove the SDK request was cancelled.
    expect(requestAborted).toBe(true);
    expect(requestedTimeouts).toEqual([timeoutMs]);
    expect((await reading).kind).toBe("unknown");
  });

  test("requests the configured freshness window and can return points older than the default window", async () => {
    const config = { ...defaultConfig, maxStalenessMs: 40 * 60_000 };
    const sourceTime = NOW - 30 * 60_000;
    const commands: GetMetricDataCommand[] = [];
    const readResult = createEbsBalanceReader({
      instanceIdentifier: "test-instance",
      clock: () => NOW,
      maxStalenessMs: config.maxStalenessMs,
      client: {
        send: async (command) => {
          commands.push(command);
          // Model CloudWatch filtering by the requested StartTime: a default
          // window mutation must actually lose this otherwise healthy point.
          const start = command.input.StartTime?.getTime();
          if (start === undefined || sourceTime < start) {
            return { $metadata: {}, MetricDataResults: [] };
          }
          return response(sourceTime, sourceTime);
        },
      },
    });
    const read = async () => (await readResult()).unwrapOr(null);
    const signal = await ebsBalance({ read, now: () => NOW, config });
    expect(sourceTime).toBeLessThan(
      NOW - defaultConfig.maxStalenessMs - 300_000,
    );
    expect(signal.kind).toBe("normal");
    expect(signal.observedAt).toBe(new Date(sourceTime).toISOString());
    expect(commands.at(0)?.input.StartTime).toEqual(
      new Date(NOW - config.maxStalenessMs - 300_000),
    );
  });
  test("requests both minimum balances in five minute periods using the instance dimension", async () => {
    const commands: GetMetricDataCommand[] = [];
    const reader = createEbsBalanceReader({
      instanceIdentifier: "test-instance",
      clock: () => NOW,
      client: {
        send: async (command, { abortSignal }) => {
          commands.push(command);
          expect(abortSignal.aborted).toBe(false);
          return response();
        },
      },
    });
    expect((await reader()).unwrap()).toEqual({
      byteBalancePct: 75,
      ioBalancePct: 85,
      observedAt: new Date(NOW).toISOString(),
    });
    expect(commands).toHaveLength(1);
    const input = commands.at(0)?.input;
    expect(input?.ScanBy).toBe("TimestampDescending");
    expect(input?.EndTime).toEqual(new Date(NOW));
    expect(
      input?.MetricDataQueries?.map(({ MetricStat }) => MetricStat),
    ).toEqual([
      {
        Metric: {
          Namespace: "AWS/RDS",
          MetricName: "EBSByteBalance%",
          Dimensions: [
            { Name: "DBInstanceIdentifier", Value: "test-instance" },
          ],
        },
        Period: 300,
        Stat: "Minimum",
      },
      {
        Metric: {
          Namespace: "AWS/RDS",
          MetricName: "EBSIOBalance%",
          Dimensions: [
            { Name: "DBInstanceIdentifier", Value: "test-instance" },
          ],
        },
        Period: 300,
        Stat: "Minimum",
      },
    ]);
  });

  test("selects newest points and retains the older source timestamp of the pair", async () => {
    const reader = createEbsBalanceReader({
      instanceIdentifier: "test",
      clock: () => NOW,
      client: {
        send: async () => ({
          $metadata: {},
          MetricDataResults: [
            {
              Id: "byte_balance",
              StatusCode: "Complete",
              Values: [10, 75, 40],
              Timestamps: [
                new Date(NOW - 300_000),
                new Date(NOW),
                new Date(NOW - 1000),
              ],
            },
            {
              Id: "io_balance",
              StatusCode: "Complete",
              Values: [85],
              Timestamps: [new Date(NOW - 300_000)],
            },
          ],
        }),
      },
    });
    expect((await reader()).unwrap()).toEqual({
      byteBalancePct: 75,
      ioBalancePct: 85,
      observedAt: new Date(NOW - 300_000).toISOString(),
    });
  });

  test.each([
    { $metadata: {} },
    { $metadata: {}, MetricDataResults: [] },
    {
      $metadata: {},
      MetricDataResults: [
        {
          Id: "byte_balance",
          StatusCode: "Complete",
          Values: [75],
          Timestamps: [new Date(NOW)],
        },
      ],
    },
    {
      $metadata: {},
      MetricDataResults: [
        { Id: "byte_balance", StatusCode: "PartialData" },
        { Id: "io_balance", StatusCode: "Complete" },
      ],
    },
    {
      $metadata: {},
      MetricDataResults: [
        {
          Id: "byte_balance",
          StatusCode: "Complete",
          Values: [Number.NaN],
          Timestamps: [new Date(NOW)],
        },
        {
          Id: "io_balance",
          StatusCode: "Complete",
          Values: [85],
          Timestamps: [new Date(NOW)],
        },
      ],
    },
  ] satisfies GetMetricDataCommandOutput[])(
    "rejects absent or incomplete metric responses %#",
    async (output) => {
      const readResult = createEbsBalanceReader({
        instanceIdentifier: "test",
        clock: () => NOW,
        client: { send: async () => output },
      });
      const outcome = await readResult();
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error).toBeInstanceOf(EbsBalanceReadError);
      }
      const read = async () => (await readResult()).unwrapOr(null);
      expect(
        (await ebsBalance({ read, now: () => NOW, config: defaultConfig }))
          .kind,
      ).toBe("unknown");
    },
  );

  test("a stale partner blocks the gate even when the other metric is fresh", async () => {
    const readResult = createEbsBalanceReader({
      instanceIdentifier: "test",
      clock: () => NOW,
      client: {
        send: async () => response(NOW, NOW - defaultConfig.maxStalenessMs - 1),
      },
    });
    const read = async () => (await readResult()).unwrapOr(null);
    expect((await readResult()).unwrap().observedAt).toBe(
      new Date(NOW - defaultConfig.maxStalenessMs - 1).toISOString(),
    );
    expect(
      (await ebsBalance({ read, now: () => NOW, config: defaultConfig })).kind,
    ).toBe("unknown");
  });

  test("a failed SDK call propagates once and blocks the gate", async () => {
    let calls = 0;
    const readResult = createEbsBalanceReader({
      instanceIdentifier: "test",
      clock: () => NOW,
      client: {
        send: async () => {
          calls += 1;
          throw new EbsBalanceReadError({
            message: "injected provider failure",
          });
        },
      },
    });
    const outcome = await readResult();
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.cause).toMatchObject({
        message: "injected provider failure",
      });
    }
    expect(calls).toBe(1);
    const read = async () => outcome.unwrapOr(null);
    expect(
      (await ebsBalance({ read, now: () => NOW, config: defaultConfig })).kind,
    ).toBe("unknown");
  });
});

test("a missing instance returns Err before contacting the provider", async () => {
  let calls = 0;
  const read = createEbsBalanceReader({
    instanceIdentifier: " ",
    clock: () => NOW,
    client: {
      send: async () => {
        calls++;
        return response();
      },
    },
  });
  const outcome = await read();
  expect(outcome.isErr()).toBe(true);
  if (outcome.isErr()) {
    expect(outcome.error.message).toContain("instance identifier");
  }
  expect(calls).toBe(0);
});
