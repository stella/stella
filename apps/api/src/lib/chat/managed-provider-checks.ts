import { Result, panic } from "better-result";

import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { createManagedProviderAvailability } from "@/api/lib/chat/managed-provider-availability";
import { getManagedOpenRouterCredential } from "@/api/lib/chat/openrouter-credential";
import {
  managedProviderUnavailable,
  fetchManagedProviderCatalog,
} from "@/api/lib/chat/provider-data-policy";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const PROVIDER_CHECK_FAILURE_SINK = failureSink({
  event: "ai.managed_provider_check.failed",
  expected: [],
});

let availability:
  | ReturnType<typeof createManagedProviderAvailability>
  | undefined;

export const checkManagedOpenRouterModel = (
  model: string,
  residency: ManagedAIResidency,
) => {
  if (!isDeploymentFeatureEnabled("FEATURE_MANAGED_PROVIDER_CHECKS")) {
    return Result.ok(undefined);
  }
  return (
    availability?.check(model, residency) ??
    Result.err(managedProviderUnavailable("openrouter"))
  );
};

export const startManagedProviderChecks = async (
  schedule = startNonOverlappingInterval,
) => {
  if (!isDeploymentFeatureEnabled("FEATURE_MANAGED_PROVIDER_CHECKS")) {
    return async () => await Promise.resolve(undefined);
  }
  const intervalMs = env.MANAGED_PROVIDER_CHECK_INTERVAL_MS;
  const timeoutMs = env.MANAGED_PROVIDER_CHECK_TIMEOUT_MS;
  if (intervalMs === undefined || timeoutMs === undefined) {
    return panic("Managed provider check configuration was not validated.");
  }
  const controller = new AbortController();
  const monitor = createManagedProviderAvailability({
    getCredential: getManagedOpenRouterCredential,
    intervalMs,
    timeoutMs,
    signal: controller.signal,
    fetchCatalog: async (url, init) =>
      await fetchManagedProviderCatalog(url, {
        ...init,
        signal: init.signal ?? undefined,
        timeoutMs,
      }),
    now: () => Temporal.Now.instant().epochMilliseconds,
  });
  availability = monitor;
  const refresh = async () => {
    const results = await monitor.refresh();
    if (controller.signal.aborted) {
      return;
    }
    for (const result of results) {
      if (Result.isError(result)) {
        observeFailure(result.error, {
          sink: PROVIDER_CHECK_FAILURE_SINK,
          ctx: {
            feature: "ai.managed_provider_check",
            source: result.error.residency,
          },
        });
      }
    }
  };
  await refresh();
  const close = schedule({
    initialDelayMs: intervalMs,
    intervalMs,
    run: refresh,
    onError: (error) =>
      observeFailure(error, { sink: PROVIDER_CHECK_FAILURE_SINK }),
  });
  return async () => {
    availability = undefined;
    controller.abort();
    await close();
  };
};
