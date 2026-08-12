import { describe, expect, mock, test } from "bun:test";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

const { readDocumentOcrWorkerAvailability, refreshDocumentOcrWorkerReadiness } =
  await import("@/api/lib/document-processing-readiness");

describe("document OCR worker readiness", () => {
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
    const writeLease = mock(
      async (_key: string, _value: string, _ttlSeconds: number) => "OK",
    );

    await refreshDocumentOcrWorkerReadiness(writeLease);

    expect(writeLease).toHaveBeenCalledWith(
      "ocr-readiness:{ocr-worker}:v1",
      "ready",
      90,
    );
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
