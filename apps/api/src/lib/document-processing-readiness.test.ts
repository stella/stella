import { describe, expect, mock, test } from "bun:test";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

const { readDocumentOcrWorkerAvailability, refreshDocumentOcrWorkerReadiness } =
  await import("@/api/lib/document-processing-readiness");

describe("document OCR worker readiness", () => {
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

  test("publishes an expiring lease atomically", async () => {
    const writeLease = mock(
      async (_key: string, _value: string, _ttlSeconds: number) => "OK",
    );

    await refreshDocumentOcrWorkerReadiness(writeLease);

    expect(writeLease).toHaveBeenCalledWith(
      "document-processing:ocr-worker-ready:v1",
      "ready",
      90,
    );
  });
});
