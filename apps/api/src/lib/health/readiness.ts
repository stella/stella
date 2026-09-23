import { Result } from "better-result";

import { HealthCheckError } from "@/api/lib/errors/tagged-errors";
import { probeDatabase } from "@/api/lib/health/probe-database";
import { probeDocumentConverter } from "@/api/lib/health/probe-document-converter";
import { createRedisClient } from "@/api/lib/redis-client";
import {
  deleteS3ObjectWithSignal,
  getS3ObjectWithSignal,
  listS3ObjectPage,
  putTemporaryS3ObjectWithSignal,
} from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

export const READINESS_DEPENDENCY = {
  database: "database",
  documentConverter: "document-converter",
  objectStorage: "object-storage",
  rawSourceErasure: "raw-source-erasure",
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
// Written with the temporary-upload tag, so readiness also proves the task may
// tag objects, which every server-side temporary write depends on. The marker
// expires with the bucket lifecycle and is rewritten; the key version moved
// with the tag so the first deploy writes instead of finding the old marker.
const S3_READINESS_KEY = "system/readiness/v2";
const S3_READINESS_CONTENT_TYPE = "application/octet-stream";
const S3_READINESS_BYTES = new Uint8Array();
let scheduledJobsReady = false;

/**
 * Exported for the suite that drives it against a real Bun client: the probe
 * sends its command on a client it has just built, so whether it passes is
 * decided by the client's own behaviour before the connection is up, which no
 * stand-in can stand in for.
 */
export const probeRedis = async (signal: AbortSignal): Promise<void> => {
  const client = createRedisClient();
  const close = () => {
    client.close();
  };
  signal.addEventListener("abort", close, { once: true });
  const result = await Result.tryPromise({
    try: async (): Promise<unknown> => await client.send("PING", []),
    // The connection failure is carried as the cause, so the Bun error code
    // that says which failure it was survives the wrap.
    catch: (cause) =>
      new HealthCheckError({ message: "Redis PING failed", cause }),
  }).finally(() => {
    signal.removeEventListener("abort", close);
    client.close();
  });
  if (Result.isOk(result) && result.value === "PONG") {
    return;
  }
  // A probe reports its dependency through the promise it returns, so a
  // failure is a rejection rather than an `Err` value: `runReadinessProbes`
  // is the boundary that turns one into the failed-dependency list, the same
  // shape `probeScheduledJobs` below reports through.
  await Promise.reject(
    Result.isError(result)
      ? result.error
      : new HealthCheckError({ message: "Redis returned an invalid PING" }),
  );
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
    await putTemporaryS3ObjectWithSignal(
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

/**
 * The raw-source prefix this process lists and deletes under: erasures and
 * the sweeps that follow them run here. A role that may write there but not
 * delete would erase nothing and report it only per erasure, so readiness
 * asks for both. The probed key is never written, so the delete removes
 * nothing; it is still refused without the permission.
 */
const RAW_SOURCE_READINESS_PREFIX = "case-law/raw/";
const RAW_SOURCE_READINESS_KEY = `${RAW_SOURCE_READINESS_PREFIX}.readiness`;

type RawSourceErasureReadinessProbe = {
  list: (signal: AbortSignal) => Promise<void>;
  delete: (signal: AbortSignal) => Promise<void>;
};

/**
 * Proven once per process: the permission is the task's, and a delete on
 * every readiness poll would add a delete marker to a versioned bucket each
 * time. A failure is not latched, so a fixed role passes on the next poll.
 */
export const createRawSourceErasureReadinessProbe = ({
  list,
  delete: remove,
}: RawSourceErasureReadinessProbe): ReadinessProbe => {
  let proven = false;
  return async (signal) => {
    if (proven) {
      return;
    }
    await list(signal);
    await remove(signal);
    proven = true;
  };
};

const probeRawSourceErasure = createRawSourceErasureReadinessProbe({
  list: async (signal) => {
    await listS3ObjectPage({
      prefix: RAW_SOURCE_READINESS_PREFIX,
      startAfter: null,
      maxKeys: 1,
      signal,
    });
  },
  delete: async (signal) => {
    await deleteS3ObjectWithSignal(RAW_SOURCE_READINESS_KEY, signal);
  },
});

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
  [READINESS_DEPENDENCY.rawSourceErasure]: probeRawSourceErasure,
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
