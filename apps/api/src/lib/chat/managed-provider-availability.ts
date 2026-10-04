import { Result, TaggedError, panic } from "better-result";
import * as v from "valibot";

import { classifyFailure } from "@stll/errors";

import {
  MANAGED_AI_RESIDENCIES,
  type ManagedAIResidency,
} from "@/api/lib/chat/ai-data-policy";
import type { ManagedOpenRouterCredential } from "@/api/lib/chat/openrouter-credential";
import {
  managedProviderUnavailable,
  PROVIDER_DATA_POLICY,
} from "@/api/lib/chat/provider-data-policy";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
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
  getCredential: () => Promise<
    Result<ManagedOpenRouterCredential, HandlerError<503>>
  >;
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  fetchCatalog: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
};

// This is a per-process safety observation, never an ownership or job lease.
// Every replica boots unavailable and expires its own observations.
export const createManagedProviderAvailability = ({
  getCredential,
  intervalMs,
  timeoutMs,
  signal: parentSignal,
  fetchCatalog,
  now,
}: ManagedProviderAvailabilityOptions) => {
  const availability = new Map<ManagedAIResidency, RegionalAvailability>(
    MANAGED_AI_RESIDENCIES.map((residency) => [
      residency,
      { status: "unavailable" },
    ]),
  );

  // Completed observations survive one slow refresh, but never indefinite stalling.
  const maxStalenessMs = 2 * intervalMs + timeoutMs;
  const refresh = async () => {
    const credential = await getCredential();
    if (Result.isError(credential)) {
      return MANAGED_AI_RESIDENCIES.map((residency) => {
        const error = classifyFailure(
          new ManagedProviderCheckError({
            message: "Managed provider credential is unavailable",
            residency,
            cause: credential.error,
          }),
          "model_unavailable",
        );
        availability.set(residency, { status: "unavailable", cause: error });
        return Result.err(error);
      });
    }
    return await Promise.all(
      MANAGED_AI_RESIDENCIES.map(async (residency) => {
        const observed = await Result.tryPromise({
          try: async () =>
            await withTimeout(
              async (signal) => {
                const url = new URL(
                  `${PROVIDER_DATA_POLICY.customer.openrouter.serverURLs[residency]}/models`,
                );
                url.searchParams.set("region", residency);
                url.searchParams.set("zdr", "true");
                const response = await fetchCatalog(url.href, {
                  headers: {
                    Authorization: `Bearer ${credential.value.apiKey}`,
                  },
                  signal,
                  redirect: "error",
                });
                if (
                  response.status === 401 &&
                  credential.value.type === "federated"
                ) {
                  credential.value.invalidate();
                }
                if (!response.ok) {
                  return Result.err(
                    new ManagedProviderCheckError({
                      message: `Regional catalog returned HTTP ${String(response.status)}`,
                      residency,
                    }),
                  );
                }
                const catalog = v.parse(
                  regionalCatalogSchema,
                  await response.json(),
                );
                return Result.ok(new Set(catalog.data.map(({ id }) => id)));
              },
              {
                label: "Managed provider catalog check",
                timeoutMs,
                signal: parentSignal,
              },
            ),
          catch: (cause) =>
            new ManagedProviderCheckError({
              message: "Managed provider catalog check failed",
              residency,
              cause,
            }),
        });
        const result = Result.flatten(observed).mapError((error) =>
          classifyFailure(error, "model_unavailable"),
        );
        if (Result.isError(result)) {
          availability.set(residency, {
            status: "unavailable",
            cause: result.error,
          });
          return result;
        }
        availability.set(residency, {
          status: "available",
          models: result.value,
          expiresAt: now() + maxStalenessMs,
        });
        return Result.ok(undefined);
      }),
    );
  };

  const check = (model: string, residency: ManagedAIResidency) => {
    const regional = availability.get(residency);
    if (regional === undefined) {
      return panic("Missing managed provider residency availability state.");
    }
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
