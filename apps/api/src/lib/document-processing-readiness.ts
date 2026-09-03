import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import { detached } from "@/api/lib/detached";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  createLazyRedisClient,
  createRedisClient,
  isTransientRedisConnectionError,
} from "@/api/lib/redis-client";
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

type DocumentOcrReadinessClient = ReturnType<typeof createRedisClient>;

const createDocumentOcrReadinessClient = () =>
  createRedisClient({
    connectionTimeout: DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
  });

// Both readiness clients are process-lifetime, so each is held through the
// lazy holder rather than as a bare client: a connection that closes is
// dropped with it and the next command builds a replacement.
const readinessReader = createLazyRedisClient(createDocumentOcrReadinessClient);

export const readDocumentOcrWorkerAvailability = async (
  readLease: () => Promise<string | null>,
  timeoutMs = DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS,
): Promise<boolean> =>
  (await withTimeout(readLease, {
    label: "document OCR readiness read",
    timeoutMs,
  })) === DOCUMENT_OCR_WORKER_READINESS_VALUE;

export const isDocumentOcrWorkerAvailable = async (
  createClient: () => Pick<
    DocumentOcrReadinessClient,
    "get"
  > = createDocumentOcrReadinessClient,
): Promise<boolean> => {
  const availability = await Result.tryPromise({
    try: async () =>
      await readDocumentOcrWorkerAvailability(async () => {
        const client =
          createClient === createDocumentOcrReadinessClient
            ? await readinessReader.ready()
            : createClient();
        return await client.get(DOCUMENT_OCR_WORKER_READINESS_KEY);
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(availability)) {
    // A dropped Redis socket rejects the first read after an idle window;
    // the caller already degrades to "worker unavailable", and the next
    // read retries on a reconnected socket.
    if (isTransientRedisConnectionError(availability.error)) {
      logger.warn("document_processing.readiness_read_disrupted", {
        "error.type": errorTag(availability.error),
      });
    } else {
      captureError(availability.error);
    }
    return false;
  }
  return availability.value;
};

const HEARTBEAT_TIMEOUT_LABEL = "document OCR readiness heartbeat";

/** Apply the lease constants. Unbounded: the caller decides its own deadline. */
const writeReadinessLease = async (
  writeLease: (
    key: CoordinationKey,
    value: string,
    ttlSeconds: number,
  ) => Promise<unknown>,
): Promise<unknown> =>
  await writeLease(
    DOCUMENT_OCR_WORKER_READINESS_KEY,
    DOCUMENT_OCR_WORKER_READINESS_VALUE,
    DOCUMENT_OCR_WORKER_READINESS_TTL_SECONDS,
  );

export const refreshDocumentOcrWorkerReadiness = async (
  writeLease: (
    key: CoordinationKey,
    value: string,
    ttlSeconds: number,
  ) => Promise<unknown>,
  timeoutMs = DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS,
): Promise<void> => {
  const write = writeReadinessLease(writeLease);
  await withTimeout(async () => await write, {
    label: HEARTBEAT_TIMEOUT_LABEL,
    timeoutMs,
  });
};

/**
 * One beat, split into the work and the caller's view of it. They are not the
 * same promise: a deadline bounds how long the caller waits, but it cancels
 * nothing, so the write and the connect behind it keep running after the
 * caller has given up on them.
 */
export type SingleFlightBeat = {
  /**
   * The underlying work. This alone decides when the slot is free, because a
   * slot released on the caller's deadline would let the next interval attach
   * a second continuation to the same pending connect.
   */
  chain: Promise<unknown>;
  /** What the caller awaits and reports on; may settle before `chain`. */
  observed: Promise<unknown>;
};

/**
 * One beat at a time, its connect included. `start` returns the caller's view
 * of the beat it started, or null when one was already running, so a caller
 * cannot observe "in flight" and act on it separately.
 */
export const createSingleFlightBeat = (runBeat: () => SingleFlightBeat) => {
  let inFlight: Promise<unknown> | null = null;
  return {
    start: (): Promise<unknown> | null => {
      if (inFlight !== null) {
        return null;
      }
      const { chain, observed } = runBeat();
      const release = (): void => {
        inFlight = null;
      };
      // Released on either outcome: a failed beat has to free the slot too,
      // or one failure would silence the heartbeat for the life of the
      // process. Swallowing here is not losing the failure — it reaches the
      // caller through `observed`.
      inFlight = chain.then(release, release);
      return observed;
    },
  };
};

export const startDocumentOcrWorkerReadiness = () => {
  const heartbeatClient = createLazyRedisClient(
    createDocumentOcrReadinessClient,
  );
  const beat = createSingleFlightBeat(() => {
    const chain = writeReadinessLease(async (key, value, ttlSeconds) => {
      const client = await heartbeatClient.ready();
      const reply: unknown = await client.send(
        "SET",
        coordinationSetArguments({
          key,
          value,
          ttl: { unit: "seconds", value: ttlSeconds },
        }),
      );
      return reply;
    });
    return {
      chain,
      // The deadline bounds only what this interval waits for and logs. The
      // connect and write keep going, and `chain` is what holds the slot, so
      // a beat that timed out while connecting still blocks the next one.
      observed: withTimeout(async () => await chain, {
        label: HEARTBEAT_TIMEOUT_LABEL,
        timeoutMs: DOCUMENT_OCR_REDIS_COMMAND_TIMEOUT_MS,
      }),
    };
  });
  const heartbeat = (): void => {
    const started = beat.start();
    if (started === null) {
      return;
    }
    // A dropped Redis socket rejects the first write after an idle window;
    // the 90s lease outlives one missed 30s beat, and the next beat writes
    // on a reconnected socket. Anything else is a defect and is captured.
    detached(
      started.catch((error: unknown) => {
        if (isTransientRedisConnectionError(error)) {
          logger.warn("document_processing.readiness_heartbeat_disrupted", {
            "error.type": errorTag(error),
          });
          return;
        }
        captureError(error);
        logger.error("document_processing.readiness_heartbeat_failed", {
          "error.type": errorTag(error),
        });
      }),
      "document-processing.readiness-heartbeat",
    );
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
      heartbeatClient.close();
    },
  };
};
