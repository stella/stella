import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import { detached } from "@/api/lib/detached";
import { createRedisClient } from "@/api/lib/redis-client";

const DOCUMENT_OCR_WORKER_READINESS_KEY =
  "document-processing:ocr-worker-ready:v1";
const DOCUMENT_OCR_WORKER_READINESS_VALUE = "ready";
const DOCUMENT_OCR_WORKER_READINESS_TTL_SECONDS = 90;
const DOCUMENT_OCR_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

let readinessReader: ReturnType<typeof createRedisClient> | null = null;

const getReadinessReader = () => {
  readinessReader ??= createRedisClient();
  return readinessReader;
};

export const readDocumentOcrWorkerAvailability = async (
  readLease: () => Promise<string | null>,
): Promise<boolean> =>
  (await readLease()) === DOCUMENT_OCR_WORKER_READINESS_VALUE;

export const isDocumentOcrWorkerAvailable = async (): Promise<boolean> => {
  const availability = await Result.tryPromise({
    try: async () =>
      await readDocumentOcrWorkerAvailability(
        async () =>
          await getReadinessReader().get(DOCUMENT_OCR_WORKER_READINESS_KEY),
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(availability)) {
    captureError(availability.error);
    return false;
  }
  return availability.value;
};

export const refreshDocumentOcrWorkerReadiness = async (
  writeLease: (
    key: string,
    value: string,
    ttlSeconds: number,
  ) => Promise<unknown>,
): Promise<void> => {
  await writeLease(
    DOCUMENT_OCR_WORKER_READINESS_KEY,
    DOCUMENT_OCR_WORKER_READINESS_VALUE,
    DOCUMENT_OCR_WORKER_READINESS_TTL_SECONDS,
  );
};

export const startDocumentOcrWorkerReadiness = () => {
  const client = createRedisClient();
  const refresh = async (): Promise<void> => {
    await refreshDocumentOcrWorkerReadiness(
      async (key, value, ttlSeconds) =>
        await client.send("SET", [key, value, "EX", String(ttlSeconds)]),
    );
  };
  const heartbeat = (): void => {
    detached(refresh(), "document-processing.readiness-heartbeat");
  };

  heartbeat();
  const interval = setInterval(
    heartbeat,
    DOCUMENT_OCR_WORKER_HEARTBEAT_INTERVAL_MS,
  );
  interval.unref();

  return {
    close: (): void => {
      clearInterval(interval);
      client.close();
    },
  };
};
