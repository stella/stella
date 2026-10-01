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
  test("requests the configured freshness window and can return points older than the default window", async () => {
    const config = { ...defaultConfig, maxStalenessMs: 40 * 60_000 };
    const sourceTime = NOW - 30 * 60_000;
    const commands: GetMetricDataCommand[] = [];
    const read = createEbsBalanceReader({
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
    expect(await reader()).toEqual({
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
    expect(await reader()).toEqual({
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
      const read = createEbsBalanceReader({
        instanceIdentifier: "test",
        clock: () => NOW,
        client: { send: async () => output },
      });
      await expect(read()).rejects.toBeInstanceOf(EbsBalanceReadError);
      expect(
        (await ebsBalance({ read, now: () => NOW, config: defaultConfig }))
          .kind,
      ).toBe("unknown");
    },
  );

  test("a stale partner blocks the gate even when the other metric is fresh", async () => {
    const read = createEbsBalanceReader({
      instanceIdentifier: "test",
      clock: () => NOW,
      client: {
        send: async () => response(NOW, NOW - defaultConfig.maxStalenessMs - 1),
      },
    });
    expect((await read()).observedAt).toBe(
      new Date(NOW - defaultConfig.maxStalenessMs - 1).toISOString(),
    );
    expect(
      (await ebsBalance({ read, now: () => NOW, config: defaultConfig })).kind,
    ).toBe("unknown");
  });

  test("a failed SDK call propagates once and blocks the gate", async () => {
    let calls = 0;
    const read = createEbsBalanceReader({
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
    expect(
      (await ebsBalance({ read, now: () => NOW, config: defaultConfig })).kind,
    ).toBe("unknown");
    expect(calls).toBe(1);
  });
});
