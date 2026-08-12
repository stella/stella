import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import { detached } from "@/api/lib/detached";
import { createRedisClient } from "@/api/lib/redis-client";
import {
  coordinationKey,
  coordinationSetArguments,
  type CoordinationKey,
} from "@/api/lib/redis-keys";
import { withTimeout } from "@/api/lib/with-timeout";

// A single process-wide lease, so the worker role is its own colocation unit.
const DOCUMENT_OCR_WORKER_READINESS_KEY = coordinationKey({
  scope: "ocr-readiness",
  slot: "ocr-worker",
  suffix: "v1",
});
const DOCUMENT_OCR_WORKER_READINESS_VALUE = "ready";
const DOCUMENT_OCR_WORKER_READINESS_TTL_SECONDS = 90;
const DOCUMENT_OCR_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
const DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS = 2000;

const createDocumentOcrReadinessClient = () =>
  createRedisClient({
    connectionTimeout: DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
  });

let readinessReader: ReturnType<typeof createRedisClient> | null = null;

const getReadinessReader = () => {
  readinessReader ??= createDocumentOcrReadinessClient();
  return readinessReader;
};

export const readDocumentOcrWorkerAvailability = async (
  readLease: () => Promise<string | null>,
  timeoutMs = DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS,
): Promise<boolean> =>
  (await withTimeout(readLease, {
    label: "document OCR readiness read",
    timeoutMs,
  })) === DOCUMENT_OCR_WORKER_READINESS_VALUE;

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
    key: CoordinationKey,
    value: string,
    ttlSeconds: number,
  ) => Promise<unknown>,
  timeoutMs = DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS,
): Promise<void> => {
  await withTimeout(
    async () =>
      await writeLease(
        DOCUMENT_OCR_WORKER_READINESS_KEY,
        DOCUMENT_OCR_WORKER_READINESS_VALUE,
        DOCUMENT_OCR_WORKER_READINESS_TTL_SECONDS,
      ),
    {
      label: "document OCR readiness heartbeat",
      timeoutMs,
    },
  );
};

export const startDocumentOcrWorkerReadiness = () => {
  const client = createDocumentOcrReadinessClient();
  let writeInFlight: Promise<unknown> | null = null;
  const refresh = async (): Promise<void> => {
    await refreshDocumentOcrWorkerReadiness(async (key, value, ttlSeconds) => {
      const write = client.send(
        "SET",
        coordinationSetArguments({
          key,
          value,
          ttl: { unit: "seconds", value: ttlSeconds },
        }),
      );
      writeInFlight = write;
      const markSettled = (): void => {
        if (writeInFlight === write) {
          writeInFlight = null;
        }
      };
      detached(
        write.then(markSettled, markSettled),
        "document-processing.readiness-heartbeat-settlement",
      );
      await write;
    });
  };
  const heartbeat = (): void => {
    if (writeInFlight !== null) {
      return;
    }
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
