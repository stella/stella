import { EventType } from "@tanstack/ai";
import type { AdapterYieldChunk, ContentPart } from "@tanstack/ai";
import { OpenRouterTextAdapter } from "@tanstack/ai-openrouter";
import type {
  createOpenRouterText,
  OpenRouterConfig,
} from "@tanstack/ai-openrouter";
import { Result } from "better-result";

import type { ManagedAIResidency } from "@/api/lib/ai-data-policy";
import { withOptionalsNullable } from "@/api/lib/json-schema/null-optionals";
import { readProviderStatus } from "@/api/lib/observability/failure-evidence";
import {
  managedProviderUnavailable,
  PROVIDER_DATA_POLICY,
} from "@/api/lib/provider-data-policy";

type OpenRouterModel = Parameters<typeof createOpenRouterText>[0];
type OpenRouterTextOptions = Parameters<
  OpenRouterTextAdapter<OpenRouterModel>["chatStream"]
>[0];

type OpenRouterStructuredOptions = Parameters<
  OpenRouterTextAdapter<OpenRouterModel>["structuredOutput"]
>[0];

const DATA_URL_PREFIX = "data:";

const documentFilename = (part: ContentPart): string | undefined => {
  if (
    part.type !== "document" ||
    typeof part.metadata !== "object" ||
    part.metadata === null ||
    !("filename" in part.metadata) ||
    typeof part.metadata.filename !== "string"
  ) {
    return undefined;
  }
  return part.metadata.filename;
};

/**
 * Stable OpenRouter Chat Completions adapter with document serialization.
 *
 * The upstream adapter intentionally rejects inline documents even though the
 * OpenRouter SDK and Chat Completions API support the `file`/`file_data` wire
 * shape. Keep this override narrow so every other modality and stream behavior
 * remains on the stable upstream adapter.
 */
export class StellaOpenRouterTextAdapter extends OpenRouterTextAdapter<OpenRouterModel> {
  // Some routes treat every declared tool field as one to fill, and write ""
  // or invented text into an optional one. On the wire an optional field
  // also admits null, so the model can say "not set"; the stream contract
  // reads each call against the declared schema, which drops that null.
  protected override mapOptionsToRequest(options: OpenRouterTextOptions) {
    return super.mapOptionsToRequest({
      ...options,
      tools: options.tools?.map((tool) =>
        tool.inputSchema === undefined
          ? tool
          : { ...tool, inputSchema: withOptionalsNullable(tool.inputSchema) },
      ),
    });
  }

  protected override convertContentPart(part: ContentPart) {
    if (part.type !== "document") {
      return super.convertContentPart(part);
    }

    const mimeType = part.source.mimeType || "application/octet-stream";
    const fileData =
      part.source.type === "data" &&
      !part.source.value.startsWith(DATA_URL_PREFIX)
        ? `data:${mimeType};base64,${part.source.value}`
        : part.source.value;
    const filename = documentFilename(part);

    return {
      type: "file" as const,
      file: {
        fileData,
        ...(filename === undefined ? {} : { filename }),
      },
    };
  }
}

/**
 * The SDK's own default retries a 5xx for up to an hour, sleeping up to a
 * minute between attempts, and a sleep does not see the run's cancel. A turn
 * waits a few seconds for a transient failure and then reports it; each
 * sleep is short, so a cancel lands within one.
 */
const OPENROUTER_RETRY: NonNullable<OpenRouterConfig["retryConfig"]> = {
  strategy: "backoff",
  backoff: {
    initialInterval: 250,
    maxInterval: 1000,
    exponent: 1.5,
    maxElapsedTime: 4000,
  },
  retryConnectionErrors: true,
};

const isManagedRoutingRefusal = (error: unknown): boolean => {
  const status = readProviderStatus(error)?.status;
  if (status !== 404 || typeof error !== "object" || error === null) {
    return false;
  }
  const body =
    "error" in error && typeof error.error === "object" && error.error !== null
      ? error.error
      : error;
  if (!("message" in body) || typeof body.message !== "string") {
    return false;
  }
  return /^No endpoints found (?:supporting your data region|matching your data policy)\.(?:\s|$)/iu.test(
    body.message,
  );
};

const withManagedRoutingErrors = async function* (
  stream: AsyncIterable<AdapterYieldChunk>,
): AsyncGenerator<AdapterYieldChunk> {
  for await (const chunk of stream) {
    if (
      chunk.type !== EventType.RUN_ERROR ||
      chunk.code === "aborted" ||
      !isManagedRoutingRefusal(chunk.rawEvent ?? chunk)
    ) {
      yield chunk;
      continue;
    }
    const error = managedProviderUnavailable("openrouter");
    const { rawEvent: _providerEvent, ...event } = chunk;
    yield {
      ...event,
      message: error.message,
      code: error.code,
      error: { message: error.message, code: error.code },
    };
  }
};

class ManagedOpenRouterTextAdapter extends StellaOpenRouterTextAdapter {
  override chatStream(options: OpenRouterTextOptions) {
    return withManagedRoutingErrors(super.chatStream(options));
  }

  override structuredOutputStream(options: OpenRouterStructuredOptions) {
    return withManagedRoutingErrors(super.structuredOutputStream(options));
  }

  override async structuredOutput(options: OpenRouterStructuredOptions) {
    const result = await Result.tryPromise({
      try: () => super.structuredOutput(options),
      catch: (error) => error,
    });
    if (Result.isOk(result)) {
      return result.value;
    }
    if (isManagedRoutingRefusal(result.error)) {
      throw managedProviderUnavailable("openrouter");
    }
    throw result.error;
  }

  protected override mapOptionsToRequest(options: OpenRouterTextOptions) {
    const {
      plugins: _plugins,
      variant: _variant,
      ...modelOptions
    } = options.modelOptions ?? {};
    const request = super.mapOptionsToRequest({
      ...options,
      model: options.model.replace(/:[^/]*$/u, ""),
      modelOptions,
    });
    return {
      ...request,
      ...(request.models === undefined
        ? {}
        : {
            models: request.models.map((model) =>
              model.replace(/:[^/]*$/u, ""),
            ),
          }),
      provider: {
        ...request.provider,
        ...PROVIDER_DATA_POLICY.customer.openrouter.provider,
      },
    };
  }
}

type ManagedOpenRouterTextOptions = {
  model: OpenRouterModel;
  apiKey: string;
  managedAIResidency: ManagedAIResidency;
};

export const createManagedOpenRouterText = ({
  model,
  apiKey,
  managedAIResidency,
}: ManagedOpenRouterTextOptions): StellaOpenRouterTextAdapter =>
  new ManagedOpenRouterTextAdapter(
    {
      apiKey,
      retryConfig: OPENROUTER_RETRY,
      serverURL:
        PROVIDER_DATA_POLICY.customer.openrouter.serverURLs[managedAIResidency],
    },
    model,
  );

export const createStellaOpenRouterText = (
  model: OpenRouterModel,
  apiKey: string,
  config?: Omit<OpenRouterConfig, "apiKey">,
): StellaOpenRouterTextAdapter =>
  new StellaOpenRouterTextAdapter(
    { apiKey, retryConfig: OPENROUTER_RETRY, ...config },
    model,
  );
