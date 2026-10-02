import { EventType } from "@tanstack/ai";
import type { AdapterYieldChunk, ContentPart } from "@tanstack/ai";
import { OpenRouterTextAdapter } from "@tanstack/ai-openrouter";
import type {
  createOpenRouterText,
  OpenRouterConfig,
} from "@tanstack/ai-openrouter";
import { Result } from "better-result";

import { Temporal } from "@stll/time";

import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import {
  assertManagedOpenRouterModel,
  managedProviderUnavailable,
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  PROVIDER_DATA_POLICY,
} from "@/api/lib/chat/provider-data-policy";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withOptionalsNullable } from "@/api/lib/json-schema/null-optionals";
import { readProviderStatus } from "@/api/lib/observability/failure-evidence";

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

const checkManagedOpenRouterRequest = (
  options: OpenRouterTextOptions,
): Result<void, HandlerError<503>> => {
  const selection = assertManagedOpenRouterModel(options.model);
  if (Result.isError(selection)) {
    return selection;
  }
  for (const model of options.modelOptions?.models ?? []) {
    const fallback = assertManagedOpenRouterModel(model);
    if (Result.isError(fallback)) {
      return fallback;
    }
  }
  return Result.ok(undefined);
};

const withManagedRoutingErrors = async function* (
  stream: AsyncIterable<AdapterYieldChunk>,
  options: OpenRouterTextOptions,
): AsyncGenerator<AdapterYieldChunk> {
  const eligibility = checkManagedOpenRouterRequest(options);
  if (Result.isError(eligibility)) {
    yield {
      type: EventType.RUN_STARTED,
      runId: Bun.randomUUIDv7(),
      threadId: options.threadId ?? Bun.randomUUIDv7(),
      model: options.model,
      timestamp: Temporal.Now.instant().epochMilliseconds,
      parentRunId: options.parentRunId,
    };
    yield {
      type: EventType.RUN_ERROR,
      model: options.model,
      timestamp: Temporal.Now.instant().epochMilliseconds,
      message: eligibility.error.message,
      code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
      error: {
        message: eligibility.error.message,
        code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
      },
    };
    return;
  }
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
    const event = { ...chunk };
    delete event.rawEvent;
    yield {
      ...event,
      message: error.message,
      code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
      error: {
        message: error.message,
        code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
      },
    };
  }
};

class ManagedOpenRouterTextAdapter extends StellaOpenRouterTextAdapter {
  override chatStream(options: OpenRouterTextOptions) {
    return withManagedRoutingErrors(super.chatStream(options), options);
  }

  override structuredOutputStream(options: OpenRouterStructuredOptions) {
    return withManagedRoutingErrors(
      super.structuredOutputStream(options),
      options.chatOptions,
    );
  }

  override async structuredOutput(options: OpenRouterStructuredOptions) {
    const eligibility = checkManagedOpenRouterRequest(options.chatOptions);
    if (Result.isError(eligibility)) {
      throw eligibility.error;
    }
    const result = await Result.tryPromise({
      try: async () => await super.structuredOutput(options),
      catch: (error) =>
        isManagedRoutingRefusal(error)
          ? managedProviderUnavailable("openrouter")
          : error,
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value;
  }

  protected override mapOptionsToRequest(options: OpenRouterTextOptions) {
    const {
      plugins: _plugins,
      variant: _variant,
      ...modelOptions
    } = options.modelOptions ?? {};
    const request = super.mapOptionsToRequest({
      ...options,
      modelOptions,
    });
    return {
      ...request,
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

type ManagedOpenRouterTextResult = Result<
  StellaOpenRouterTextAdapter,
  HandlerError<503>
>;

export const createManagedOpenRouterText = ({
  model,
  apiKey,
  managedAIResidency,
}: ManagedOpenRouterTextOptions): ManagedOpenRouterTextResult => {
  const eligibility = assertManagedOpenRouterModel(model);
  if (Result.isError(eligibility)) {
    return eligibility;
  }
  return Result.ok(
    new ManagedOpenRouterTextAdapter(
      {
        apiKey,
        retryConfig: OPENROUTER_RETRY,
        serverURL:
          PROVIDER_DATA_POLICY.customer.openrouter.serverURLs[
            managedAIResidency
          ],
      },
      model,
    ),
  );
};

export const createStellaOpenRouterText = (
  model: OpenRouterModel,
  apiKey: string,
  config?: Omit<OpenRouterConfig, "apiKey">,
): StellaOpenRouterTextAdapter =>
  new StellaOpenRouterTextAdapter(
    { apiKey, retryConfig: OPENROUTER_RETRY, ...config },
    model,
  );
