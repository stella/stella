import { HTTPClient } from "@openrouter/sdk";
import { EventType } from "@tanstack/ai";
import type { AdapterYieldChunk, ContentPart } from "@tanstack/ai";
import { OpenRouterTextAdapter } from "@tanstack/ai-openrouter";
import type {
  createOpenRouterText,
  OpenRouterConfig,
} from "@tanstack/ai-openrouter";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Result } from "better-result";

import { Temporal } from "@stll/time";

import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { checkManagedOpenRouterModel } from "@/api/lib/chat/managed-provider-checks";
import type { ManagedOpenRouterCredential } from "@/api/lib/chat/openrouter-credential";
import {
  assertManagedOpenRouterModel,
  fetchManagedOpenRouterCompletion,
  managedProviderUnavailable,
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  PROVIDER_DATA_POLICY,
  withoutModelVariant,
} from "@/api/lib/chat/provider-data-policy";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withOptionalsNullable } from "@/api/lib/json-schema/null-optionals";
import {
  readEvidence,
  readProviderStatus,
} from "@/api/lib/observability/failure-evidence";
import { isRecord } from "@/api/lib/type-guards";

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
  constructor(config: OpenRouterConfig, model: OpenRouterModel) {
    super(config, model);
    const sendRequest = this.orClient.chat.send.bind(this.orClient.chat);
    type SendRequest = Parameters<typeof sendRequest>[0];
    type SendOptions = Parameters<typeof sendRequest>[1];
    type SendResponse = Awaited<ReturnType<typeof sendRequest>>;
    type SendStreamResponse = Extract<SendResponse, AsyncIterable<unknown>>;
    function sendWithRequestId(
      request: SendRequest & { chatRequest: { stream?: false | undefined } },
      options?: SendOptions,
    ): Promise<Exclude<SendResponse, SendStreamResponse>>;
    function sendWithRequestId(
      request: SendRequest & { chatRequest: { stream: true } },
      options?: SendOptions,
    ): Promise<SendStreamResponse>;
    function sendWithRequestId(
      request: SendRequest,
      options?: SendOptions,
    ): Promise<SendResponse>;
    async function sendWithRequestId(
      request: SendRequest,
      options?: SendOptions,
    ) {
      const result = await Result.tryPromise({
        try: async () => await sendRequest(request, options),
        catch: (error) => {
          if (!isRecord(error) || !(error["rawResponse"] instanceof Response)) {
            return error;
          }
          const requestId =
            error["rawResponse"].headers.get("x-request-id") ??
            error["rawResponse"].headers.get("request-id");
          if (requestId === null) {
            return error;
          }
          // The adapter carries provider-owned evidence through rawEvent.
          // Project the request id here, while the SDK response is available.
          Object.defineProperty(error, "rawEvent", {
            configurable: true,
            value: {
              requestId,
              status: readProviderStatus(error)?.status,
              cause: error["rawEvent"] ?? error["error"] ?? error["metadata"],
            },
          });
          return error;
        },
      });
      if (Result.isError(result)) {
        throw result.error;
      }
      return result.value;
    }
    this.orClient.chat.send = sendWithRequestId;
  }

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

const OPENROUTER_DATA_REGION_FILTER = "Filter by Data Region";

const isManagedRoutingRefusal = (error: unknown): boolean => {
  const status = readProviderStatus(error)?.status;
  if (status !== 404 || typeof error !== "object" || error === null) {
    return false;
  }
  const body =
    "error" in error && typeof error.error === "object" && error.error !== null
      ? error.error
      : error;
  if (
    !("metadata" in body) ||
    typeof body.metadata !== "object" ||
    body.metadata === null ||
    !("failed_routing_step" in body.metadata) ||
    body.metadata.failed_routing_step !== OPENROUTER_DATA_REGION_FILTER
  ) {
    return false;
  }
  return true;
};

const checkManagedOpenRouterRequest = (
  options: OpenRouterTextOptions,
  residency: ManagedAIResidency,
): Result<void, HandlerError<503>> => {
  const selection = assertManagedOpenRouterModel(options.model);
  if (Result.isError(selection)) {
    return selection;
  }
  return checkManagedOpenRouterModel(
    withoutModelVariant(options.model),
    residency,
  );
};

type ManagedRoutingOptions = {
  stream: AsyncIterable<AdapterYieldChunk>;
  options: OpenRouterTextOptions;
  managedAIResidency: ManagedAIResidency;
};

const withManagedRequestEligibility = async function* ({
  stream,
  options,
  managedAIResidency,
}: ManagedRoutingOptions): AsyncGenerator<AdapterYieldChunk> {
  const eligibility = checkManagedOpenRouterRequest(
    options,
    managedAIResidency,
  );
  if (Result.isError(eligibility)) {
    yield {
      type: EventType.RUN_STARTED,
      runId: Bun.randomUUIDv7(),
      threadId: options.threadId ?? Bun.randomUUIDv7(),
      model: options.model,
      timestamp: Temporal.Now.instant().epochMilliseconds,
      ...(options.parentRunId === undefined
        ? {}
        : { parentRunId: options.parentRunId }),
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
  yield* withManagedProviderErrors(stream, isManagedRoutingRefusal);
};

const withManagedProviderErrors = async function* (
  stream: AsyncIterable<AdapterYieldChunk>,
  isUnavailable: (error: unknown) => boolean,
): AsyncGenerator<AdapterYieldChunk> {
  for await (const chunk of stream) {
    if (
      chunk.type !== EventType.RUN_ERROR ||
      chunk.code === "aborted" ||
      (chunk.code !== MANAGED_PROVIDER_UNAVAILABLE_CODE &&
        !isUnavailable(chunk.rawEvent ?? chunk))
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

const INSTANCE_DEBUG_LOGGER = {
  group: () => undefined,
  groupEnd: () => undefined,
  log: () => undefined,
} satisfies NonNullable<OpenRouterConfig["debugLogger"]>;

class InstanceOpenRouterTextAdapter extends StellaOpenRouterTextAdapter {
  private readonly credential: ManagedOpenRouterCredential;
  constructor(
    config: OpenRouterConfig,
    model: OpenRouterModel,
    credential: ManagedOpenRouterCredential,
  ) {
    // A truthy logger also prevents OPENROUTER_DEBUG from enabling SDK logs.
    super(
      {
        ...config,
        debugLogger: INSTANCE_DEBUG_LOGGER,
        httpClient: new HTTPClient({
          fetcher: async (
            input: Request | URL | string,
            init?: RequestInit,
          ) => {
            const request =
              input instanceof Request
                ? input
                : new Request(input.toString(), init);
            const result = await fetchManagedOpenRouterCompletion(request);
            if (Result.isError(result)) {
              throw result.error;
            }
            return result.value;
          },
        }),
      },
      model,
    );
    // Normalize after the SDK promise settles; rejecting its internal result
    // promise leaves a second APIPromise branch unhandled.
    const sendRequest = this.orClient.chat.send.bind(this.orClient.chat);
    type SendRequest = Parameters<typeof sendRequest>[0];
    type SendOptions = Parameters<typeof sendRequest>[1];
    type SendResponse = Awaited<ReturnType<typeof sendRequest>>;
    type SendStreamResponse = Extract<SendResponse, AsyncIterable<unknown>>;
    function sendManagedRequest(
      request: SendRequest & { chatRequest: { stream?: false | undefined } },
      options?: SendOptions,
    ): Promise<Exclude<SendResponse, SendStreamResponse>>;
    function sendManagedRequest(
      request: SendRequest & { chatRequest: { stream: true } },
      options?: SendOptions,
    ): Promise<SendStreamResponse>;
    function sendManagedRequest(
      request: SendRequest,
      options?: SendOptions,
    ): Promise<SendResponse>;
    async function sendManagedRequest(
      request: SendRequest,
      options?: SendOptions,
    ) {
      const result = await Result.tryPromise({
        try: async () => await sendRequest(request, options),
        catch: (error) =>
          readEvidence(error).nodes.some(
            ({ code }) => code === MANAGED_PROVIDER_UNAVAILABLE_CODE,
          )
            ? managedProviderUnavailable("openrouter")
            : error,
      });
      if (Result.isError(result)) {
        throw result.error;
      }
      return result.value;
    }
    this.orClient.chat.send = sendManagedRequest;
    this.credential = credential;
  }

  private readonly isFederatedCredentialRefusal = (error: unknown): boolean => {
    if (
      this.credential.type !== "federated" ||
      readProviderStatus(error)?.status !== 401
    ) {
      return false;
    }
    this.credential.invalidate();
    return true;
  };

  override chatStream(options: OpenRouterTextOptions) {
    return withManagedProviderErrors(
      super.chatStream({ ...options, logger: resolveDebugOption(false) }),
      this.isFederatedCredentialRefusal,
    );
  }

  override structuredOutputStream(options: OpenRouterStructuredOptions) {
    return withManagedProviderErrors(
      super.structuredOutputStream({
        ...options,
        chatOptions: {
          ...options.chatOptions,
          logger: resolveDebugOption(false),
        },
      }),
      this.isFederatedCredentialRefusal,
    );
  }

  override async structuredOutput(options: OpenRouterStructuredOptions) {
    const result = await Result.tryPromise({
      try: async () =>
        await super.structuredOutput({
          ...options,
          chatOptions: {
            ...options.chatOptions,
            logger: resolveDebugOption(false),
          },
        }),
      catch: (error) =>
        this.isFederatedCredentialRefusal(error)
          ? managedProviderUnavailable("openrouter")
          : error,
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value;
  }

  protected override mapOptionsToRequest(options: OpenRouterTextOptions) {
    const { models: _models, ...modelOptions } = options.modelOptions ?? {};
    return super.mapOptionsToRequest({ ...options, modelOptions });
  }
}

class ManagedOpenRouterTextAdapter extends InstanceOpenRouterTextAdapter {
  private readonly residency: ManagedAIResidency;

  constructor(
    config: OpenRouterConfig,
    {
      model,
      managedAIResidency,
      credential,
    }: Pick<ManagedOpenRouterTextOptions, "model" | "managedAIResidency"> & {
      credential: ManagedOpenRouterCredential;
    },
  ) {
    super(config, model, credential);
    this.residency = managedAIResidency;
  }
  override chatStream(options: OpenRouterTextOptions) {
    return withManagedRequestEligibility({
      stream: super.chatStream(options),
      options,
      managedAIResidency: this.residency,
    });
  }

  override structuredOutputStream(options: OpenRouterStructuredOptions) {
    return withManagedRequestEligibility({
      stream: super.structuredOutputStream(options),
      options: options.chatOptions,
      managedAIResidency: this.residency,
    });
  }

  override async structuredOutput(options: OpenRouterStructuredOptions) {
    const eligibility = checkManagedOpenRouterRequest(
      options.chatOptions,
      this.residency,
    );
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
    const model = withoutModelVariant(options.model);
    const {
      plugins: _plugins,
      variant: _variant,
      ...modelOptions
    } = options.modelOptions ?? {};
    const request = super.mapOptionsToRequest({
      ...options,
      model,
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
  managedAIResidency: ManagedAIResidency;
} & (
  | { apiKey: string; credential?: never }
  | { credential: ManagedOpenRouterCredential; apiKey?: never }
);

type ManagedOpenRouterTextResult = Result<
  StellaOpenRouterTextAdapter,
  HandlerError<503>
>;

export const createManagedOpenRouterText = (
  options: ManagedOpenRouterTextOptions,
): ManagedOpenRouterTextResult => {
  const eligibility = assertManagedOpenRouterModel(options.model);
  if (Result.isError(eligibility)) {
    return eligibility;
  }
  const credential = options.credential ?? {
    type: "static" as const,
    apiKey: options.apiKey,
  };
  return Result.ok(
    new ManagedOpenRouterTextAdapter(
      {
        apiKey: credential.apiKey,
        retryConfig: OPENROUTER_RETRY,
        serverURL:
          PROVIDER_DATA_POLICY.customer.openrouter.serverURLs[
            options.managedAIResidency
          ],
      },
      {
        model: options.model,
        managedAIResidency: options.managedAIResidency,
        credential,
      },
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
