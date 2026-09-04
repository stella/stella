import { Result } from "better-result";

import { HealthCheckError } from "@/api/lib/errors/tagged-errors";
import { probeDatabase } from "@/api/lib/health/probe-database";
import { probeDocumentConverter } from "@/api/lib/health/probe-document-converter";
import { createRedisClient } from "@/api/lib/redis-client";
import { getS3ObjectWithSignal, putS3ObjectWithSignal } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

export const READINESS_DEPENDENCY = {
  database: "database",
  documentConverter: "document-converter",
  objectStorage: "object-storage",
  redis: "redis",
  scheduledJobs: "scheduled-jobs",
} as const;

export type ReadinessDependency =
  (typeof READINESS_DEPENDENCY)[keyof typeof READINESS_DEPENDENCY];

export const API_READINESS_DEPENDENCIES = Object.values(READINESS_DEPENDENCY);

type ReadinessProbe = (signal: AbortSignal) => Promise<void>;
export type ReadinessProbes = Record<ReadinessDependency, ReadinessProbe>;
export type ReadinessOutcome =
  | { status: "ready" }
  | { status: "not-ready"; failed: ReadinessDependency[] };

const PROBE_TIMEOUT_MS = 5000;
const S3_READINESS_KEY = "system/readiness/v1";
const S3_READINESS_CONTENT_TYPE = "application/octet-stream";
const S3_READINESS_BYTES = new Uint8Array();
let scheduledJobsReady = false;

const probeRedis = async (signal: AbortSignal): Promise<void> => {
  const client = createRedisClient();
  const close = () => {
    client.close();
  };
  signal.addEventListener("abort", close, { once: true });
  const result = await Result.tryPromise({
    try: async (): Promise<unknown> => {
      // The client is built with the offline queue disabled, so the PING has
      // to wait for the socket rather than be buffered behind it: on a client
      // that has not connected yet the command is rejected outright, which
      // would report the dependency down whatever its actual state.
      await client.connect();
      return await client.send("PING", []);
    },
    catch: (cause) => cause,
  }).finally(() => {
    signal.removeEventListener("abort", close);
    client.close();
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  if (result.value !== "PONG") {
    throw new HealthCheckError({ message: "Redis returned an invalid PING" });
  }
};

type ObjectStorageReadinessProbe = {
  read: (signal: AbortSignal) => Promise<void>;
  write: (signal: AbortSignal) => Promise<void>;
};

export const probeObjectStorageReadiness = async (
  { read, write }: ObjectStorageReadinessProbe,
  signal: AbortSignal,
): Promise<void> => {
  const existingMarker = await Result.tryPromise({
    try: async () => await read(signal),
    catch: (cause) => cause,
  });
  if (Result.isOk(existingMarker)) {
    return;
  }
  await write(signal);
  await read(signal);
};

const objectStorageReadinessProbe = {
  read: async (signal: AbortSignal) => {
    await getS3ObjectWithSignal(S3_READINESS_KEY, signal);
  },
  write: async (signal: AbortSignal) => {
    await putS3ObjectWithSignal(
      S3_READINESS_KEY,
      S3_READINESS_BYTES,
      S3_READINESS_CONTENT_TYPE,
      signal,
    );
  },
} satisfies ObjectStorageReadinessProbe;

const probeObjectStorage = async (signal: AbortSignal): Promise<void> => {
  await probeObjectStorageReadiness(objectStorageReadinessProbe, signal);
};

const probeScheduledJobs = async (): Promise<void> => {
  if (!scheduledJobsReady) {
    await Promise.reject(
      new HealthCheckError({
        message: "Scheduled jobs are not registered",
      }),
    );
  }
};

const runtimeReadinessProbes = {
  [READINESS_DEPENDENCY.database]: async () => {
    await probeDatabase();
  },
  [READINESS_DEPENDENCY.documentConverter]: async (signal) => {
    await probeDocumentConverter(signal, PROBE_TIMEOUT_MS);
  },
  [READINESS_DEPENDENCY.objectStorage]: probeObjectStorage,
  [READINESS_DEPENDENCY.redis]: probeRedis,
  [READINESS_DEPENDENCY.scheduledJobs]: probeScheduledJobs,
} satisfies ReadinessProbes;

export const markScheduledJobsReady = (): void => {
  scheduledJobsReady = true;
};

export const runReadinessProbes = async (
  probes: ReadinessProbes,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ReadinessOutcome> => {
  const outcomes = await Promise.all(
    API_READINESS_DEPENDENCIES.map(async (dependency) => {
      const result = await Result.tryPromise({
        try: async () =>
          await withTimeout(probes[dependency], {
            label: `${dependency} readiness probe`,
            timeoutMs,
          }),
        catch: (cause) => cause,
      });
      return Result.isError(result) ? dependency : null;
    }),
  );
  const failed = outcomes.filter(
    (dependency): dependency is ReadinessDependency => dependency !== null,
  );
  return failed.length === 0
    ? { status: "ready" }
    : { status: "not-ready", failed };
};

export const probeApiReadiness = async (): Promise<ReadinessOutcome> =>
  await runReadinessProbes(runtimeReadinessProbes);
