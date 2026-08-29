import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isTransientRedisConnectionError } from "@/api/lib/redis-client";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

let readinessGet = async (): Promise<string | null> => null;

const {
  isDocumentOcrWorkerAvailable,
  readDocumentOcrWorkerAvailability,
  refreshDocumentOcrWorkerReadiness,
} = await import("@/api/lib/document-processing-readiness");

const createReadinessClient = () => ({ get: readinessGet });

describe("document OCR worker readiness", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  test("configures readiness clients to fail fast during Redis outages", async () => {
    const source = await Bun.file(
      new URL("document-processing-readiness.ts", import.meta.url),
    ).text();

    expect(source).toContain(
      "connectionTimeout: DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS",
    );
    expect(source).toContain("enableOfflineQueue: false");
    expect(source.match(/createDocumentOcrReadinessClient\(\)/gu)).toHaveLength(
      2,
    );
  });

  test("reports availability only from a live shared lease", async () => {
    expect(await readDocumentOcrWorkerAvailability(async () => "ready")).toBe(
      true,
    );
    expect(await readDocumentOcrWorkerAvailability(async () => null)).toBe(
      false,
    );
    expect(await readDocumentOcrWorkerAvailability(async () => "stale")).toBe(
      false,
    );
  });

  test("degrades to unavailable on a dropped socket without capturing", async () => {
    // The transient and non-transient fixtures must classify differently,
    // or both assertions below would pass through the same branch.
    const transient = Object.assign(new Error("Connection closed"), {
      code: "ERR_REDIS_CONNECTION_CLOSED",
    });
    const defect = Object.assign(new Error("WRONGTYPE"), {
      code: "ERR_REDIS_INVALID_TYPE",
    });
    expect(isTransientRedisConnectionError(transient)).toBe(true);
    expect(isTransientRedisConnectionError(defect)).toBe(false);

    readinessGet = async () => {
      throw transient;
    };
    expect(await isDocumentOcrWorkerAvailable(createReadinessClient)).toBe(
      false,
    );
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toMatchObject([
      {
        message: "document_processing.readiness_read_disrupted",
        attributes: { "error.type": "Error" },
      },
    ]);

    readinessGet = async () => {
      throw defect;
    };
    expect(await isDocumentOcrWorkerAvailable(createReadinessClient)).toBe(
      false,
    );
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "Error", "error.code": "ERR_REDIS_INVALID_TYPE" },
    ]);
    // The defect took the capture branch, so no second disruption warning.
    expect(logs.at("WARN")).toHaveLength(1);
  });

  test("bounds readiness reads", async () => {
    const neverResolves = new Promise<string | null>(() => {
      // Deliberately pending to exercise the caller's deadline.
    });

    const rejection: unknown = await readDocumentOcrWorkerAvailability(
      async () => await neverResolves,
      5,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: "document OCR readiness read exceeded 5ms",
    });
  });

  test("publishes an expiring lease atomically", async () => {
    const calls: [string, string, number][] = [];
    const writeLease = async (
      key: string,
      value: string,
      ttlSeconds: number,
    ) => {
      calls.push([key, value, ttlSeconds]);
      return "OK";
    };

    await refreshDocumentOcrWorkerReadiness(writeLease);

    expect(calls).toEqual([["ocr-readiness:{ocr-worker}:v1", "ready", 90]]);
  });

  test("bounds readiness heartbeats", async () => {
    const neverResolves = new Promise<unknown>(() => {
      // Deliberately pending to exercise the caller's deadline.
    });

    const rejection: unknown = await refreshDocumentOcrWorkerReadiness(
      async () => await neverResolves,
      5,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: "document OCR readiness heartbeat exceeded 5ms",
    });
  });
});
