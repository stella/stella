import { Result, TaggedError, panic } from "better-result";
import * as v from "valibot";

import { classifyFailure } from "@stll/errors";

import {
  MANAGED_AI_RESIDENCIES,
  type ManagedAIResidency,
} from "@/api/lib/chat/ai-data-policy";
import {
  managedProviderUnavailable,
  PROVIDER_DATA_POLICY,
} from "@/api/lib/chat/provider-data-policy";
import { withTimeout } from "@/api/lib/with-timeout";

const regionalCatalogSchema = v.object({
  data: v.array(v.object({ id: v.string() })),
});

export class ManagedProviderCheckError extends TaggedError(
  "ManagedProviderCheckError",
)<{
  message: string;
  residency: ManagedAIResidency;
  cause?: unknown;
}> {}

type RegionalAvailability =
  | { status: "unavailable"; cause?: ManagedProviderCheckError }
  | { status: "available"; models: ReadonlySet<string>; expiresAt: number };

type ManagedProviderAvailabilityOptions = {
  apiKey: string;
  intervalMs: number;
  timeoutMs: number;
  fetchCatalog: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
};

// This is a per-process safety observation, never an ownership or job lease.
// Every replica boots unavailable and expires its own observations.
export const createManagedProviderAvailability = ({
  apiKey,
  intervalMs,
  timeoutMs,
  fetchCatalog,
  now,
}: ManagedProviderAvailabilityOptions) => {
  const availability: Record<ManagedAIResidency, RegionalAvailability> = {
    eu: { status: "unavailable" },
    us: { status: "unavailable" },
  };

  const refresh = async () =>
    await Promise.all(
      MANAGED_AI_RESIDENCIES.map(async (residency) => {
        availability[residency] = { status: "unavailable" };
        const expiresAt = now() + intervalMs;
        const result = await Result.tryPromise({
          try: async () =>
            await withTimeout(
              async (signal) => {
                const url = new URL(
                  `${PROVIDER_DATA_POLICY.customer.openrouter.serverURLs[residency]}/models`,
                );
                url.searchParams.set("region", residency);
                url.searchParams.set("zdr", "true");
                const response = await fetchCatalog(url.href, {
                  headers: { Authorization: `Bearer ${apiKey}` },
                  signal,
                  redirect: "error",
                });
                if (!response.ok) {
                  throw new ManagedProviderCheckError({
                    message: `Regional catalog returned HTTP ${String(response.status)}`,
                    residency,
                  });
                }
                const catalog = v.parse(
                  regionalCatalogSchema,
                  await response.json(),
                );
                return new Set(catalog.data.map(({ id }) => id));
              },
              { label: "Managed provider catalog check", timeoutMs },
            ),
          catch: (cause) =>
            classifyFailure(
              new ManagedProviderCheckError({
                message: "Managed provider catalog check failed",
                residency,
                cause,
              }),
              "model_unavailable",
            ),
        });
        if (Result.isError(result)) {
          availability[residency] = {
            status: "unavailable",
            cause: result.error,
          };
          return result;
        }
        availability[residency] = {
          status: "available",
          models: result.value,
          expiresAt,
        };
        return Result.ok(undefined);
      }),
    );

  const check = (model: string, residency: ManagedAIResidency) => {
    const regional = availability[residency];
    switch (regional.status) {
      case "available":
        return now() < regional.expiresAt && regional.models.has(model)
          ? Result.ok(undefined)
          : Result.err(managedProviderUnavailable("openrouter"));
      case "unavailable":
        return Result.err(
          managedProviderUnavailable("openrouter", regional.cause),
        );
      default:
        regional satisfies never;
        return panic("Unknown managed provider availability state.");
    }
  };

  return { refresh, check };
};
