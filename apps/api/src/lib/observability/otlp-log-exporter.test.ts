import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  createOtlpLogExporter,
  LOG_SEVERITY_NUMBER,
  type OtlpLogExporterOptions,
  type OtlpLogExportFailure,
} from "./otlp-log-exporter";

type ReceivedRequest = {
  readonly body: unknown;
  readonly headers: Headers;
  readonly path: string;
};

type Receiver = {
  readonly requests: ReceivedRequest[];
  readonly url: string;
  /** Resolves once the receiver has seen `count` requests. */
  readonly received: (count: number) => Promise<void>;
};

const servers: { stop: (force?: boolean) => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop(true)));
});

/** A real OTLP endpoint on loopback; `respond` decides each answer. */
const startReceiver = (
  respond: (
    request: ReceivedRequest,
    index: number,
  ) => Promise<Response> | Response = () => new Response("{}", { status: 200 }),
): Receiver => {
  const requests: ReceivedRequest[] = [];
  const waiters: { count: number; resolve: (value: undefined) => void }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const received: ReceivedRequest = {
        body: await request.json(),
        headers: request.headers,
        path: new URL(request.url).pathname,
      };
      requests.push(received);
      for (const waiter of waiters.filter((w) => requests.length >= w.count)) {
        waiter.resolve(undefined);
      }
      return respond(received, requests.length - 1);
    },
  });
  servers.push(server);
  return {
    requests,
    url: `${server.url.origin}/v1/logs`,
    received: async (count) => {
      if (requests.length >= count) {
        return;
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      waiters.push({ count, resolve });
      await promise;
    },
  };
};

const OtlpLogsRequestSchema = v.object({
  resourceLogs: v.array(
    v.object({
      scopeLogs: v.array(
        v.object({
          logRecords: v.array(
            v.object({
              attributes: v.array(
                v.object({ key: v.string(), value: v.unknown() }),
              ),
              body: v.unknown(),
              droppedAttributesCount: v.number(),
              observedTimeUnixNano: v.string(),
              timeUnixNano: v.string(),
            }),
          ),
        }),
      ),
    }),
  ),
});

const recordsIn = (body: unknown) => {
  const { resourceLogs } = v.parse(OtlpLogsRequestSchema, body);
  return resourceLogs.flatMap(({ scopeLogs }) =>
    scopeLogs.flatMap(({ logRecords }) => logRecords),
  );
};

const exporterFor = (
  url: string,
  overrides: Partial<OtlpLogExporterOptions> = {},
) => {
  const failures: OtlpLogExportFailure[] = [];
  const exporter = createOtlpLogExporter({
    headers: { Authorization: "Bearer otlp-test-token" },
    onFailure: (failure) => failures.push(failure),
    resource: { "service.name": "stella-api", "service.version": "1.2.3" },
    scopeName: "stella.api",
    url,
    // Timer exports stay out of the way unless a test asks for them.
    scheduledDelayMs: 60_000,
    initialBackoffMs: 5,
    ...overrides,
  });
  return { exporter, failures };
};

const info = (body: string) => ({
  body,
  severityNumber: LOG_SEVERITY_NUMBER.INFO,
  severityText: "INFO",
});

describe("OTLP log export", () => {
  test("sends OTLP/HTTP JSON with resource, scope, severity, typed attributes and nanosecond times", async () => {
    const receiver = startReceiver();
    const { exporter, failures } = exporterFor(receiver.url);
    const beforeNanos = BigInt(Date.now()) * 1_000_000n;

    exporter.emit({
      attributes: {
        "http.route": "/matters/:id",
        "http.status_code": 503,
        "request.duration_ms": 12.5,
        "failure.shadow": true,
        "log.tags": ["a", "b"],
        "log.counts": [1, 2],
      },
      body: "request.failed",
      severityNumber: LOG_SEVERITY_NUMBER.ERROR,
      severityText: "ERROR",
    });
    exporter.emit(info("api.shutdown_started"));
    await exporter.flush();
    const afterNanos = BigInt(Date.now()) * 1_000_000n;

    expect(failures).toEqual([]);
    expect(receiver.requests).toHaveLength(1);
    const [request] = receiver.requests;
    expect(request?.path).toBe("/v1/logs");
    expect(request?.headers.get("authorization")).toBe(
      "Bearer otlp-test-token",
    );
    expect(request?.headers.get("content-type")).toBe("application/json");

    const records = recordsIn(request?.body);
    for (const record of records) {
      expect(record.timeUnixNano).toMatch(/^\d+$/u);
      expect(BigInt(record.timeUnixNano)).toBeGreaterThanOrEqual(beforeNanos);
      expect(BigInt(record.timeUnixNano)).toBeLessThanOrEqual(afterNanos);
      expect(record.observedTimeUnixNano).toBe(record.timeUnixNano);
    }
    expect(request?.body).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "stella-api" } },
              { key: "service.version", value: { stringValue: "1.2.3" } },
            ],
            droppedAttributesCount: 0,
          },
          scopeLogs: [
            {
              scope: { name: "stella.api" },
              logRecords: [
                {
                  timeUnixNano: records[0]?.timeUnixNano,
                  observedTimeUnixNano: records[0]?.timeUnixNano,
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: "request.failed" },
                  attributes: [
                    {
                      key: "http.route",
                      value: { stringValue: "/matters/:id" },
                    },
                    { key: "http.status_code", value: { intValue: 503 } },
                    {
                      key: "request.duration_ms",
                      value: { doubleValue: 12.5 },
                    },
                    { key: "failure.shadow", value: { boolValue: true } },
                    {
                      key: "log.tags",
                      value: {
                        arrayValue: {
                          values: [{ stringValue: "a" }, { stringValue: "b" }],
                        },
                      },
                    },
                    {
                      key: "log.counts",
                      value: {
                        arrayValue: {
                          values: [{ intValue: 1 }, { intValue: 2 }],
                        },
                      },
                    },
                  ],
                  droppedAttributesCount: 0,
                },
                {
                  timeUnixNano: records[1]?.timeUnixNano,
                  observedTimeUnixNano: records[1]?.timeUnixNano,
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "api.shutdown_started" },
                  attributes: [],
                  droppedAttributesCount: 0,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test("keeps the first 128 attributes of a record and counts the rest as dropped", async () => {
    const receiver = startReceiver();
    const { exporter } = exporterFor(receiver.url);
    const attributes = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`attr.${index}`, index]),
    );

    exporter.emit({ ...info("wide.record"), attributes });
    await exporter.flush();

    const [record] = recordsIn(receiver.requests[0]?.body);
    expect(record?.attributes.map(({ key }) => key)).toEqual(
      Object.keys(attributes).slice(0, 128),
    );
    expect(record?.droppedAttributesCount).toBe(2);
  });

  test("exports on the scheduled delay without anyone flushing", async () => {
    const receiver = startReceiver();
    const { exporter } = exporterFor(receiver.url, { scheduledDelayMs: 10 });

    exporter.emit(info("timer.export"));
    expect(receiver.requests).toHaveLength(0);
    await receiver.received(1);

    expect(
      recordsIn(receiver.requests[0]?.body).map((record) => record.body),
    ).toEqual([{ stringValue: "timer.export" }]);
  });

  test("sends a full batch at once and splits a flush into batches of the export size", async () => {
    const receiver = startReceiver();
    const { exporter } = exporterFor(receiver.url, { maxExportBatchSize: 2 });

    for (const index of [1, 2, 3, 4, 5]) {
      exporter.emit(info(`record.${index}`));
    }
    // Two full batches leave on their own; the fifth record waits.
    await receiver.received(2);
    await exporter.flush();

    expect(
      receiver.requests.map((request) => recordsIn(request.body).length),
    ).toEqual([2, 2, 1]);
  });

  test("drops records past the queue bound and reports the overflow once", async () => {
    const receiver = startReceiver();
    const { exporter, failures } = exporterFor(receiver.url, {
      maxExportBatchSize: 3,
      maxQueueSize: 3,
    });

    for (const index of [1, 2, 3, 4, 5]) {
      exporter.emit(info(`record.${index}`));
    }
    await exporter.flush();

    expect(failures).toEqual([{ kind: "queue_full", maxQueueSize: 3 }]);
    expect(
      recordsIn(receiver.requests[0]?.body).map((record) => record.body),
    ).toEqual([
      { stringValue: "record.1" },
      { stringValue: "record.2" },
      { stringValue: "record.3" },
    ]);
  });

  test("retries a throttled export after Retry-After and delivers it", async () => {
    const receiver = startReceiver((_request, index) =>
      index === 0
        ? new Response("", { headers: { "Retry-After": "0" }, status: 503 })
        : new Response("{}", { status: 200 }),
    );
    const { exporter, failures } = exporterFor(receiver.url);

    exporter.emit(info("retried.record"));
    await exporter.flush();

    expect(failures).toEqual([]);
    expect(receiver.requests).toHaveLength(2);
    expect(receiver.requests[1]?.body).toEqual(receiver.requests[0]?.body);
  });

  test("reports a rejected export once without retrying it or throwing", async () => {
    const receiver = startReceiver(
      () => new Response("bad payload", { status: 400 }),
    );
    const failures: OtlpLogExportFailure[] = [];
    const { exporter } = exporterFor(receiver.url, {
      onFailure: (failure) => {
        failures.push(failure);
        throw new TypeError("reporter is broken too");
      },
    });

    exporter.emit(info("rejected.record"));
    await exporter.flush();

    expect(receiver.requests).toHaveLength(1);
    expect(failures).toEqual([
      { kind: "http_status", attempts: 1, records: 1, status: 400 },
    ]);
  });

  test("gives up on an unreachable endpoint after five attempts", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const closedUrl = `${closed.url.origin}/v1/logs`;
    await closed.stop(true);
    const { exporter, failures } = exporterFor(closedUrl);

    exporter.emit(info("unreachable.record"));
    await exporter.flush();

    expect(failures).toEqual([
      {
        kind: "network",
        attempts: 5,
        errorName: expect.any(String),
        records: 1,
      },
    ]);
  });

  test("bounds an export to a slow endpoint by the export deadline", async () => {
    const receiver = startReceiver(async () => {
      await Bun.sleep(5000);
      return new Response("{}", { status: 200 });
    });
    const { exporter, failures } = exporterFor(receiver.url, {
      exportTimeoutMs: 200,
    });

    exporter.emit(info("slow.record"));
    const startedAt = performance.now();
    await exporter.flush();

    expect(performance.now() - startedAt).toBeLessThan(2000);
    expect(failures).toEqual([
      {
        kind: "network",
        attempts: expect.any(Number),
        errorName: "TimeoutError",
        records: 1,
      },
    ]);
  });
});
