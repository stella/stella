import { Result, TaggedError, panic } from "better-result";
import path from "node:path";

import type { BYOKProvider } from "@stll/ai-catalog";
import { MODELS_DEV_RATE_PROVIDER_BY_CATALOG_PROVIDER } from "@stll/ai-catalog";
import { fetchWithTimeout } from "@stll/fetch";

export const MODELS_DEV_KEY_BY_PROVIDER = {
  ...MODELS_DEV_RATE_PROVIDER_BY_CATALOG_PROVIDER,
  openrouter: "openrouter",
} as const satisfies Record<BYOKProvider, string>;

export const MODEL_CATALOG_INPUT_DIR = path.resolve(
  import.meta.dir,
  "../../ai-catalog/upstream",
);

class CatalogSnapshotError extends TaggedError("CatalogSnapshotError")<{
  message: string;
  cause?: unknown;
}> {}

export class CatalogSnapshotRefreshTimeoutError extends TaggedError(
  "CatalogSnapshotRefreshTimeoutError",
)<{
  message: string;
  cause?: unknown;
}> {}

const CATALOG_REFRESH_TOTAL_TIMEOUT_MS = 60_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

export const serializeCatalogInput = (value: unknown): string =>
  `${JSON.stringify(canonicalize(value), null, 2)}\n`;

// Retain the cost object in full: unknown cost axes must still fail generation.
const MODEL_FIELDS = [
  "cost",
  "reasoning",
  "reasoning_options",
  "release_date",
  "temperature",
  "tool_call",
] as const;

export const reduceModelsDevInput = (payload: unknown): unknown => {
  if (!isObject(payload)) {
    return panic("models.dev returned a non-object catalog");
  }
  const providers = new Map<string, unknown>();
  for (const provider of Object.values(MODELS_DEV_KEY_BY_PROVIDER)) {
    const entry = payload[provider];
    if (!isObject(entry) || !isObject(entry["models"])) {
      return panic(`models.dev ${provider} catalog has no model map`);
    }
    const models = new Map<string, unknown>();
    for (const [id, model] of Object.entries(entry["models"])) {
      if (!isObject(model)) {
        return panic(`models.dev ${provider}/${id} is not an object`);
      }
      const fields = new Map<string, unknown>();
      for (const field of MODEL_FIELDS) {
        if (field in model) {
          fields.set(field, model[field]);
        }
      }
      for (const [field, nested] of [
        ["modalities", "input"],
        ["limit", "output"],
      ] as const) {
        const value = model[field];
        if (isObject(value) && nested in value) {
          fields.set(field, { [nested]: value[nested] });
        }
      }
      models.set(id, Object.fromEntries(fields));
    }
    providers.set(provider, { models: Object.fromEntries(models) });
  }
  return Object.fromEntries(providers);
};

export const reduceOpenRouterInput = (payload: unknown): unknown => {
  if (!isObject(payload) || !Array.isArray(payload["data"])) {
    return panic("OpenRouter returned no model array");
  }
  const models = new Map<string, unknown>();
  for (const model of payload["data"]) {
    if (!isObject(model) || typeof model["id"] !== "string") {
      return panic("OpenRouter returned a model without an id");
    }
    const reasoning = model["reasoning"];
    if (
      isObject(reasoning) &&
      typeof reasoning["default_effort"] === "string"
    ) {
      models.set(model["id"], {
        id: model["id"],
        reasoning: { default_effort: reasoning["default_effort"] },
      });
    }
  }
  return { data: [...models.keys()].toSorted().map((id) => models.get(id)) };
};

const fetchInput = async (
  url: string,
  signal: AbortSignal,
): Promise<unknown> => {
  const result = Result.flatten(
    await Result.tryPromise({
      try: async () => {
        const response = await fetchWithTimeout(url, {
          headers: { accept: "application/json" },
          signal,
          timeout: { type: "idle", ms: 30_000 },
        });
        if (!response.ok) {
          return Result.err(
            new CatalogSnapshotError({
              message: `${url} responded ${response.status}`,
            }),
          );
        }
        const payload: unknown = await response.json();
        return Result.ok(payload);
      },
      catch: (cause) =>
        new CatalogSnapshotError({
          message: `Could not refresh ${url}`,
          cause,
        }),
    }),
  );
  if (Result.isError(result)) {
    return panic(result.error.message, result.error);
  }
  return result.value;
};

type RefreshModelCatalogInputsOptions = {
  fetcher?: typeof fetchInput;
  timeoutMs?: number;
};

export const refreshModelCatalogInputs = async ({
  fetcher = fetchInput,
  timeoutMs = CATALOG_REFRESH_TOTAL_TIMEOUT_MS,
}: RefreshModelCatalogInputsOptions = {}) => {
  const signal = AbortSignal.timeout(timeoutMs);
  return await Result.tryPromise({
    try: async () => {
      const [modelsDevRaw, openRouterRaw] = await Promise.all([
        fetcher("https://models.dev/api.json", signal),
        fetcher("https://openrouter.ai/api/v1/models", signal),
      ]);
      return { modelsDevRaw, openRouterRaw };
    },
    catch: (cause) =>
      signal.aborted
        ? new CatalogSnapshotRefreshTimeoutError({
            message: `Model catalog refresh exceeded its ${timeoutMs}ms total deadline`,
            cause,
          })
        : new CatalogSnapshotError({
            message: "Could not refresh model catalog inputs",
            cause,
          }),
  });
};

export const loadModelCatalogSnapshot = async () => {
  const refresh = Bun.argv.includes("--refresh");
  if (
    refresh &&
    (Bun.argv.includes("--check") || Bun.argv.includes("--from-snapshot"))
  ) {
    return panic(
      "--refresh cannot be combined with --check or --from-snapshot",
    );
  }
  const modelsDevFile = path.join(
    MODEL_CATALOG_INPUT_DIR,
    "models.dev.gen.json",
  );
  const openRouterFile = path.join(
    MODEL_CATALOG_INPUT_DIR,
    "openrouter.gen.json",
  );
  if (!refresh) {
    const modelsDev: unknown = await Bun.file(modelsDevFile).json();
    const openRouter: unknown = await Bun.file(openRouterFile).json();
    return { modelsDev, openRouter };
  }
  const refreshed = await refreshModelCatalogInputs();
  if (refreshed.isErr()) {
    return panic(refreshed.error.message, refreshed.error);
  }
  const { modelsDevRaw, openRouterRaw } = refreshed.value;
  const modelsDev = reduceModelsDevInput(modelsDevRaw);
  const openRouter = reduceOpenRouterInput(openRouterRaw);
  await Bun.write(modelsDevFile, serializeCatalogInput(modelsDev));
  await Bun.write(openRouterFile, serializeCatalogInput(openRouter));
  return { modelsDev, openRouter };
};
