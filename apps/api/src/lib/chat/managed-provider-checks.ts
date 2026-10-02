import { Result, panic } from "better-result";

import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { createManagedProviderAvailability } from "@/api/lib/chat/managed-provider-availability";
import {
  managedProviderUnavailable,
  fetchManagedProviderCatalog,
} from "@/api/lib/chat/provider-data-policy";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";

let availability:
  | ReturnType<typeof createManagedProviderAvailability>
  | undefined;

export const checkManagedOpenRouterModel = (
  model: string,
  residency: ManagedAIResidency,
) => {
  if (!env.FEATURE_MANAGED_PROVIDER_CHECKS) {
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
  if (!env.FEATURE_MANAGED_PROVIDER_CHECKS) {
    return async () => undefined;
  }
  const intervalMs = env.MANAGED_PROVIDER_CHECK_INTERVAL_MS;
  const timeoutMs = env.MANAGED_PROVIDER_CHECK_TIMEOUT_MS;
  const apiKey = env.OPENROUTER_API_KEY;
  if (
    intervalMs === undefined ||
    timeoutMs === undefined ||
    apiKey === undefined
  ) {
    return panic("Managed provider check configuration was not validated.");
  }
  const controller = new AbortController();
  const monitor = createManagedProviderAvailability({
    apiKey,
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
        captureError(result.error, {
          context: { residency: result.error.residency },
        });
      }
    }
  };
  await refresh();
  const close = schedule({
    initialDelayMs: intervalMs,
    intervalMs,
    run: refresh,
    onError: captureError,
  });
  return async () => {
    availability = undefined;
    controller.abort();
    await close();
  };
};
