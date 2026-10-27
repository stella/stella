/**
 * OTLP/HTTP JSON log exporter on the operator-endpoint transport.
 *
 * Records are queued in memory and exported in batches: on a timer, as soon as
 * a full batch is waiting, and on `flush()`. Export never blocks or throws into
 * the caller; a failed or dropped export is reported through `onFailure`,
 * which must not log through the exporter it reports on.
 *
 * The wire format and the delivery rules mirror what the OpenTelemetry log SDK
 * did for us (batch processor plus OTLP/HTTP JSON exporter): one resource, one
 * instrumentation scope, nanosecond string timestamps, typed attribute values,
 * retries on 429/502/503/504 and network failures with backoff or the server's
 * `Retry-After`, all inside one export deadline.
 */

import { Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { createCoalescedDrain } from "@stll/concurrency/coalesced-drain";
import { Temporal } from "@stll/time";

import { postToOperatorEndpoint } from "@/api/lib/observability/operator-endpoint-fetch";

/** OTLP severity numbers for the levels the API logger emits. */
export const LOG_SEVERITY_NUMBER = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
} as const;

export type LogSeverityNumber =
  (typeof LOG_SEVERITY_NUMBER)[keyof typeof LOG_SEVERITY_NUMBER];

export type LogAttributeValue =
  boolean | boolean[] | number | number[] | string | string[];

type LogAttributes = Record<string, LogAttributeValue>;

type OtlpLogRecordInput = {
  readonly attributes?: LogAttributes | undefined;
  readonly body: string;
  readonly severityNumber: LogSeverityNumber;
  readonly severityText: string;
};

export type OtlpLogExportFailure =
  | {
      readonly kind: "http_status";
      readonly attempts: number;
      readonly records: number;
      readonly status: number;
    }
  | {
      readonly kind: "network";
      readonly attempts: number;
      readonly errorName: string;
      readonly records: number;
    }
  | { readonly kind: "queue_full"; readonly maxQueueSize: number };

export type OtlpLogExporterOptions = {
  readonly headers: Readonly<Record<string, string>>;
  readonly onFailure: (failure: OtlpLogExportFailure) => void;
  readonly resource: Readonly<Record<string, string>>;
  readonly scopeName: string;
  readonly url: string;
  /** Upper bound for one export including its retries. */
  readonly exportTimeoutMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxExportBatchSize?: number;
  readonly maxQueueSize?: number;
  readonly scheduledDelayMs?: number;
};

export type OtlpLogExporter = {
  /** Queue one record; never throws and never waits on the network. */
  readonly emit: (record: OtlpLogRecordInput) => void;
  /** Export every queued record; resolves once all of them settled. */
  readonly flush: () => Promise<void>;
};

// The OpenTelemetry SDK defaults this exporter replaces.
const DEFAULT_SCHEDULED_DELAY_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 2048;
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 512;
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 5000;
const BACKOFF_MULTIPLIER = 1.5;
const BACKOFF_JITTER = 0.2;
const ATTRIBUTE_COUNT_LIMIT = 128;

type OtlpAnyValue =
  | { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } }
  | { readonly boolValue: boolean }
  | { readonly doubleValue: number }
  | { readonly intValue: number }
  | { readonly stringValue: string };

type OtlpKeyValue = { readonly key: string; readonly value: OtlpAnyValue };

type QueuedRecord = {
  readonly attributes: readonly OtlpKeyValue[];
  readonly body: string;
  readonly droppedAttributesCount: number;
  readonly severityNumber: LogSeverityNumber;
  readonly severityText: string;
  readonly timeUnixNano: string;
};

const toAnyValue = (value: boolean | number | string): OtlpAnyValue => {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
};

const toAttributeValue = (value: LogAttributeValue): OtlpAnyValue =>
  Array.isArray(value)
    ? { arrayValue: { values: value.map(toAnyValue) } }
    : toAnyValue(value);

const toKeyValues = (
  attributes: Readonly<Record<string, LogAttributeValue>>,
): OtlpKeyValue[] =>
  Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toAttributeValue(value),
  }));

/** Wall clock as OTLP's nanosecond string. */
const nowUnixNano = (): string =>
  String(Temporal.Now.instant().epochNanoseconds);

const toQueuedRecord = (record: OtlpLogRecordInput): QueuedRecord => {
  const entries = toKeyValues(record.attributes ?? {});
  return {
    attributes: entries.slice(0, ATTRIBUTE_COUNT_LIMIT),
    body: record.body,
    droppedAttributesCount: Math.max(0, entries.length - ATTRIBUTE_COUNT_LIMIT),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    timeUnixNano: nowUnixNano(),
  };
};

const isRetryableStatus = (status: number): boolean =>
  status === 429 || status === 502 || status === 503 || status === 504;

/** `Retry-After` in milliseconds: delta seconds or an HTTP date. */
const parseRetryAfterMs = (header: string | null): number | undefined => {
  if (header === null) {
    return undefined;
  }
  const seconds = parseIntegerToken(header, { sign: "unsigned" });
  if (Result.isOk(seconds)) {
    return seconds.value * 1000;
  }
  // HTTP-date is IMF-fixdate rather than an ISO Temporal grammar. Date is the
  // platform parser for this legacy protocol form.
  const at = new Date(header).getTime();
  return Number.isNaN(at)
    ? undefined
    : Math.max(at - Temporal.Now.instant().epochMilliseconds, 0);
};

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "UnknownError";

type AttemptOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "http_status";
      readonly retryAfterMs: number | undefined;
      readonly status: number;
    }
  | { readonly kind: "network"; readonly errorName: string };

export const createOtlpLogExporter = (
  options: OtlpLogExporterOptions,
): OtlpLogExporter => {
  const scheduledDelayMs =
    options.scheduledDelayMs ?? DEFAULT_SCHEDULED_DELAY_MS;
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const maxExportBatchSize = Math.min(
    options.maxExportBatchSize ?? DEFAULT_MAX_EXPORT_BATCH_SIZE,
    maxQueueSize,
  );
  const exportTimeoutMs = options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const initialBackoffMs =
    options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const resource = {
    attributes: toKeyValues(options.resource),
    droppedAttributesCount: 0,
  };
  const headers = {
    ...options.headers,
    "Content-Type": "application/json",
  };

  let queue: QueuedRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queueFullReported = false;

  // A failing reporter has nothing left to report through, so it is dropped
  // rather than turned into a caller error.
  const report = (failure: OtlpLogExportFailure) => {
    Result.try(() => {
      options.onFailure(failure);
    }).unwrapOr(undefined);
  };

  const body = (records: readonly QueuedRecord[]) =>
    JSON.stringify({
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope: { name: options.scopeName },
              logRecords: records.map((record) => ({
                timeUnixNano: record.timeUnixNano,
                observedTimeUnixNano: record.timeUnixNano,
                severityNumber: record.severityNumber,
                severityText: record.severityText,
                body: { stringValue: record.body },
                attributes: record.attributes,
                droppedAttributesCount: record.droppedAttributesCount,
              })),
            },
          ],
        },
      ],
    });

  const attempt = async (
    payload: string,
    timeoutMs: number,
  ): Promise<AttemptOutcome> => {
    const sent = await postToOperatorEndpoint({
      body: payload,
      headers,
      timeout: { type: "headers", ms: timeoutMs },
      url: options.url,
    });
    if (sent.isErr()) {
      return { kind: "network", errorName: errorName(sent.error.cause) };
    }
    const response = sent.value;
    if (response.ok) {
      return { kind: "ok" };
    }
    return {
      kind: "http_status",
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
      status: response.status,
    };
  };

  const exportBatch = async (records: readonly QueuedRecord[]) => {
    const payload = body(records);
    const deadline = performance.now() + exportTimeoutMs;
    let backoffMs = initialBackoffMs;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const outcome = await attempt(
        payload,
        Math.max(deadline - performance.now(), 1),
      );
      if (outcome.kind === "ok") {
        return;
      }
      const retryable =
        outcome.kind === "network" || isRetryableStatus(outcome.status);
      const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER;
      const delayMs =
        outcome.kind === "http_status" && outcome.retryAfterMs !== undefined
          ? outcome.retryAfterMs
          : Math.min(backoffMs * jitter, MAX_BACKOFF_MS);
      backoffMs *= BACKOFF_MULTIPLIER;
      if (
        !retryable ||
        attempts >= MAX_ATTEMPTS ||
        delayMs > deadline - performance.now()
      ) {
        report(
          outcome.kind === "network"
            ? {
                kind: "network",
                attempts,
                errorName: outcome.errorName,
                records: records.length,
              }
            : {
                kind: "http_status",
                attempts,
                records: records.length,
                status: outcome.status,
              },
        );
        return;
      }
      await Bun.sleep(delayMs);
    }
  };

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /**
   * Export what is queued when this export starts, batch by batch. Records
   * emitted meanwhile wait for their own timer, so a steady stream of logs
   * cannot keep one flush from settling.
   */
  const drain = async () => {
    clearTimer();
    let remaining = queue.length;
    while (remaining > 0 && queue.length > 0) {
      const batch = queue.slice(0, Math.min(maxExportBatchSize, remaining));
      queue = queue.slice(batch.length);
      remaining -= batch.length;
      queueFullReported = false;
      await exportBatch(batch);
    }
  };
  const requestDrain = createCoalescedDrain(drain);

  const startExport = (): void => {
    requestDrain();
  };

  const flush = async (): Promise<void> => {
    await requestDrain().completion;
  };

  const schedule = () => {
    if (queue.length >= maxExportBatchSize) {
      clearTimer();
      startExport();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        startExport();
      }, scheduledDelayMs);
      // A pending export must not keep the process alive on its own.
      timer.unref();
    }
  };

  return {
    emit: (record) => {
      if (queue.length >= maxQueueSize) {
        if (!queueFullReported) {
          queueFullReported = true;
          report({ kind: "queue_full", maxQueueSize });
        }
        return;
      }
      queue.push(toQueuedRecord(record));
      schedule();
    },
    flush,
  };
};
