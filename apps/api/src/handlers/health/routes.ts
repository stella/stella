import { Result } from "better-result";

import { STELLA_REST_API_CONTRACT_VERSION } from "@stll/api-contract";

import { DEPLOY_ENV_CONTRACT } from "@/api/deploy-env-contract";
import { envBase } from "@/api/env-base";
import type { ResponseSet } from "@/api/http/context";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
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
import { sanctionsStartupWarmup } from "@/api/lib/lists/sanctions/public-read-owner";
import { APP_COMMIT_SHA, APP_VERSION } from "@/api/lib/version";

const BUILD_METADATA = {
  apiContractVersion: STELLA_REST_API_CONTRACT_VERSION,
  version: APP_VERSION,
  commit: APP_COMMIT_SHA,
};

const PROBE_CACHE_TTL_MS = 5000;

type HealthRouteOptions = {
  readDeployEnvironment?: () => typeof envBase.DEPLOY_ENVIRONMENT;
  probeReadiness?: () => Promise<ReadinessOutcome>;
  probeSanctionsStartup?: () => "warming" | "terminal";
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
  readDeployEnvironment = () => envBase.DEPLOY_ENVIRONMENT,
  probeReadiness = probeApiReadiness,
  probeSanctionsStartup = () => sanctionsStartupWarmup.status().status,
}: HealthRouteOptions = {}) => {
  const readinessFields = Object.fromEntries(
    DEPLOY_ENV_CONTRACT.flatMap(({ readinessField }) =>
      readinessField === undefined
        ? []
        : [[readinessField, readDeployEnvironment() ?? null]],
    ),
  );
  const probeCache = createProbeCache(
    async () => await readinessOutcome(probeReadiness),
    { ttlMs: PROBE_CACHE_TTL_MS },
  );
  const startupGate = createStartupGate();
  const readinessResponse = async () => await probeCache.run();
  const livenessHandler = () => ({
    status: "ok",
    ...BUILD_METADATA,
  });
  const readinessHandler = async ({ set }: { readonly set: ResponseSet }) => {
    const outcome = await readinessResponse();
    if (!outcome.ok) {
      set.status = 503;
      return {
        status: "error",
        message: "Required dependency unavailable",
        ...readinessFields,
        ...BUILD_METADATA,
      };
    }
    return { status: "ok", ...readinessFields, ...BUILD_METADATA };
  };

  const startedHandler = async ({ set }: { readonly set: ResponseSet }) => {
    if (startupGate.startup() === STARTUP_STATE.started) {
      return { status: STARTUP_STATE.started, ...BUILD_METADATA };
    }
    const outcome = await readinessResponse();
    if (!outcome.ok || probeSanctionsStartup() !== "terminal") {
      set.status = 503;
      return { status: STARTUP_STATE.starting, ...BUILD_METADATA };
    }
    startupGate.markStarted();
    return { status: STARTUP_STATE.started, ...BUILD_METADATA };
  };

  const liveness = defineEndpoint.public({}, livenessHandler);
  return routes({
    "/live": { GET: liveness },
    "/ready": { GET: defineEndpoint.public({}, readinessHandler) },
    "/started": { GET: defineEndpoint.public({}, startedHandler) },
    "/health": { GET: liveness },
  });
};

export const healthRoute = createHealthRoute();
