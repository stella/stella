import { Result } from "better-result";
import Elysia from "elysia";
import type { Context } from "elysia";

import { STELLA_REST_API_CONTRACT_VERSION } from "@stll/api-contract";

import { HealthCheckError } from "@/api/lib/errors/tagged-errors";
import { createProbeCache } from "@/api/lib/health/probe-cache";
import type { ProbeOutcome } from "@/api/lib/health/probe-cache";
import {
  probeApiReadiness,
  type ReadinessOutcome,
} from "@/api/lib/health/readiness";
import {
  createStartupGate,
  STARTUP_STATE,
} from "@/api/lib/health/startup-gate";
import { APP_COMMIT_SHA, APP_VERSION } from "@/api/lib/version";

const BUILD_METADATA = {
  apiContractVersion: STELLA_REST_API_CONTRACT_VERSION,
  version: APP_VERSION,
  commit: APP_COMMIT_SHA,
};

const PROBE_CACHE_TTL_MS = 5000;

type HealthRouteOptions = {
  probeReadiness?: () => Promise<ReadinessOutcome>;
};

const readinessOutcome = async (
  probeReadiness: () => Promise<ReadinessOutcome>,
): Promise<ProbeOutcome<HealthCheckError>> => {
  const result = await Result.tryPromise({
    try: probeReadiness,
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    return {
      ok: false,
      error: new HealthCheckError({
        message: "API readiness probe failed",
        cause: result.error,
      }),
    };
  }
  return result.value.status === "ready"
    ? { ok: true }
    : {
        ok: false,
        error: new HealthCheckError({
          message: "Required API dependency is unavailable",
        }),
      };
};

export const createHealthRoute = ({
  probeReadiness = probeApiReadiness,
}: HealthRouteOptions = {}) => {
  const probeCache = createProbeCache(
    async () => await readinessOutcome(probeReadiness),
    { ttlMs: PROBE_CACHE_TTL_MS },
  );
  const startupGate = createStartupGate();
  const readinessResponse = async () => {
    const outcome = await probeCache.run();
    if (outcome.ok) {
      startupGate.markStarted();
    }
    return outcome;
  };
  const livenessHandler = () => ({
    status: "ok" as const,
    ...BUILD_METADATA,
  });
  const readinessHandler = async ({ set }: Pick<Context, "set">) => {
    const outcome = await readinessResponse();
    if (!outcome.ok) {
      set.status = 503;
      return {
        status: "error" as const,
        message: "Required dependency unavailable",
        ...BUILD_METADATA,
      };
    }
    return { status: "ok" as const, ...BUILD_METADATA };
  };

  const startedHandler = async ({ set }: Pick<Context, "set">) => {
    if (startupGate.startup() === STARTUP_STATE.started) {
      return { status: STARTUP_STATE.started, ...BUILD_METADATA };
    }
    const outcome = await readinessResponse();
    if (!outcome.ok) {
      set.status = 503;
      return { status: STARTUP_STATE.starting, ...BUILD_METADATA };
    }
    return { status: STARTUP_STATE.started, ...BUILD_METADATA };
  };

  return new Elysia()
    .get("/live", livenessHandler)
    .get("/ready", readinessHandler)
    .get("/started", startedHandler)
    .get("/health", livenessHandler);
};

export const healthRoute = createHealthRoute();
