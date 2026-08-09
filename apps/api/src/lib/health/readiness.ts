import { Result } from "better-result";

import { env } from "@/api/env";
import { HealthCheckError } from "@/api/lib/errors/tagged-errors";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { probeDatabase } from "@/api/lib/health/probe-database";
import { basicAuthorizationHeader } from "@/api/lib/http-basic-auth";
import { createRedisClient } from "@/api/lib/redis-client";
import { getS3 } from "@/api/lib/s3";
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
let scheduledJobsReady = false;

const probeRedis = async (signal: AbortSignal): Promise<void> => {
  const client = createRedisClient();
  const close = () => {
    client.close();
  };
  signal.addEventListener("abort", close, { once: true });
  const result = await Result.tryPromise({
    try: async (): Promise<unknown> => await client.send("PING", []),
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

const probeObjectStorage = async (): Promise<void> => {
  await getS3().exists(S3_READINESS_KEY);
};

const probeDocumentConverter = async (signal: AbortSignal): Promise<void> => {
  const response = await fetchWithTimeout(`${env.GOTENBERG_URL}/health`, {
    headers: {
      Authorization: basicAuthorizationHeader(
        env.GOTENBERG_USERNAME,
        env.GOTENBERG_PASSWORD,
      ),
    },
    signal,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new HealthCheckError({
      message: "Document converter health probe failed",
    });
  }
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
  [READINESS_DEPENDENCY.documentConverter]: probeDocumentConverter,
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
