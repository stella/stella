import type { AnyTextAdapter, ContentPart, ModelMessage } from "@tanstack/ai";
import { panic, Result } from "better-result";

import {
  getModelImageInputCapability,
  type TanStackAIProvider,
} from "@stll/ai-catalog";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { runError } from "@/api/lib/chat/provider-stream-contract";
import { validateDataUrl } from "@/api/lib/data-url";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { withTimeout } from "@/api/lib/with-timeout";

// Converse limits each decoded image to 3.75 MB (independent of the upload cap).
export const BEDROCK_IMAGE_MAX_BYTES = 3_750_000;
export const IMAGE_INPUT_UNSUPPORTED_CODE = "image_input_unsupported";
const BEDROCK_IMAGE_INVALID_CODE = "bedrock_image_invalid";
const BEDROCK_IMAGE_MAX_EDGE = 8000;
const REENCODE_MAX_EDGE = 2048;
const REENCODE_WEBP_QUALITY = 85;
const PREPARED_IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const PREPARED_IMAGE_CACHE_MAX_ENTRIES = 64;
const MAX_IMAGE_BASE64_LENGTH =
  4 * Math.ceil(FILE_SIZE_LIMIT_BYTES.chatContextFile / 3);

export const imageInputUnsupportedError = () =>
  new HandlerError({
    code: IMAGE_INPUT_UNSUPPORTED_CODE,
    status: 422,
    message:
      "This model cannot read attached images. Remove the image or switch to a model that supports images.",
  });

const invalidBedrockImage = (cause?: unknown) =>
  new HandlerError({
    code: BEDROCK_IMAGE_INVALID_CODE,
    status: 422,
    message:
      "This image could not be prepared within Bedrock's image limits. Upload a smaller image or switch models.",
    cause,
  });

type ImagePart = Extract<ContentPart, { type: "image" }>;
type PreparedBedrockImages = {
  sources: Map<string, Extract<ImagePart["source"], { type: "data" }>>;
  bytes: number;
};

const prepareBedrockImage = async (
  part: ImagePart,
  preparedImages?: PreparedBedrockImages,
): Promise<Result<ImagePart, HandlerError>> => {
  let payload: string;
  if (part.source.type === "url") {
    const inline = validateDataUrl({
      maxBytes: FILE_SIZE_LIMIT_BYTES.chatContextFile,
      url: part.source.value,
    });
    if (Result.isError(inline)) {
      return Result.err(invalidBedrockImage(inline.error));
    }
    payload = inline.value.payload;
  } else if (part.source.type === "data") {
    payload = part.source.value;
  } else {
    // Nothing is fetched on the model's behalf, including file references.
    return Result.err(invalidBedrockImage());
  }
  if (payload.length > MAX_IMAGE_BASE64_LENGTH) {
    return Result.err(invalidBedrockImage());
  }
  // Inline URL and data sources share the same identity after validation.
  // Hashes retain no original attachment bytes; target settings are part of it.
  const cacheKey =
    preparedImages === undefined
      ? undefined
      : `${BEDROCK_IMAGE_MAX_BYTES}:${BEDROCK_IMAGE_MAX_EDGE}:${REENCODE_MAX_EDGE}:${REENCODE_WEBP_QUALITY}:${payload.length}:${hashSha256Hex(payload)}`;
  const cached =
    cacheKey === undefined ? undefined : preparedImages?.sources.get(cacheKey);
  if (
    cached !== undefined &&
    cacheKey !== undefined &&
    preparedImages !== undefined
  ) {
    preparedImages.sources.delete(cacheKey);
    preparedImages.sources.set(cacheKey, cached);
    return Result.ok({ ...part, source: cached });
  }
  const source = Buffer.from(payload, "base64");
  if (source.byteLength > FILE_SIZE_LIMIT_BYTES.chatContextFile) {
    return Result.err(invalidBedrockImage());
  }
  Bun.Image.backend = "bun";
  const prepared = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () => {
          const image = new Bun.Image(source, { autoOrient: true });
          const { width, height } = await image.metadata();
          if (
            source.byteLength <= BEDROCK_IMAGE_MAX_BYTES &&
            width <= BEDROCK_IMAGE_MAX_EDGE &&
            height <= BEDROCK_IMAGE_MAX_EDGE
          ) {
            return Result.ok(part);
          }
          if (width * height > LIMITS.imageDerivativeSourcePixelsMax) {
            return Result.err(invalidBedrockImage());
          }
          // WebP preserves alpha; one bounded encode avoids repeated full decodes.
          const bytes = await image
            .resize(REENCODE_MAX_EDGE, REENCODE_MAX_EDGE, {
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: REENCODE_WEBP_QUALITY })
            .bytes();
          if (bytes.byteLength > BEDROCK_IMAGE_MAX_BYTES) {
            return Result.err(invalidBedrockImage());
          }
          return Result.ok({
            ...part,
            source: {
              type: "data",
              value: Buffer.from(bytes).toString("base64"),
              mimeType: "image/webp",
            },
          } satisfies ImagePart);
        },
        { label: "bedrock-image", timeoutMs: LIMITS.imageDerivativeTimeoutMs },
      ),
    catch: (cause) => invalidBedrockImage(cause),
  });
  if (Result.isError(prepared)) {
    return prepared;
  }
  const converted = prepared.value;
  if (Result.isError(converted)) {
    return converted;
  }
  const output = converted.value;
  if (
    output !== part &&
    output.source.type === "data" &&
    preparedImages !== undefined &&
    cacheKey !== undefined
  ) {
    // Count UTF-16 storage conservatively; retain only bounded transformed data.
    const bytes = output.source.value.length * 2;
    while (
      preparedImages.sources.size >= PREPARED_IMAGE_CACHE_MAX_ENTRIES ||
      preparedImages.bytes + bytes > PREPARED_IMAGE_CACHE_MAX_BYTES
    ) {
      const oldest = preparedImages.sources.entries().next().value;
      if (oldest === undefined) {
        break;
      }
      preparedImages.sources.delete(oldest[0]);
      preparedImages.bytes -= oldest[1].value.length * 2;
    }
    preparedImages.sources.set(cacheKey, output.source);
    preparedImages.bytes += bytes;
  }
  return Result.ok(output);
};

type PrepareProviderImageMessagesOptions = {
  messages: ModelMessage[];
  modelId: string;
  provider: TanStackAIProvider;
  preparedImages?: PreparedBedrockImages;
};

export const prepareProviderImageMessages = async ({
  messages,
  modelId,
  provider,
  preparedImages,
}: PrepareProviderImageMessagesOptions): Promise<
  Result<ModelMessage[], HandlerError>
> => {
  const hasImages = messages.some(
    ({ content }) =>
      Array.isArray(content) && content.some((part) => part.type === "image"),
  );
  if (!hasImages) {
    return Result.ok(messages);
  }
  const capability = getModelImageInputCapability({ provider, modelId });
  switch (capability) {
    case "unsupported":
      return Result.err(imageInputUnsupportedError());
    case "unknown":
    case undefined:
      logger.info("ai.image_capability_unknown", {
        provider,
        image_capability_unknown: true,
        reason: capability === undefined ? "unlisted_model" : "catalog_unknown",
      });
      break;
    case "supported":
      break;
    default:
      capability satisfies never;
      return panic(`Unhandled image capability: ${String(capability)}`);
  }
  if (provider !== "bedrock") {
    return Result.ok(messages);
  }
  // Sequential processing bounds peak decoded memory for multi-image messages.
  const prepared: ModelMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      prepared.push(message);
      continue;
    }
    const content: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== "image") {
        content.push(part);
        continue;
      }
      const image = await prepareBedrockImage(part, preparedImages);
      if (Result.isError(image)) {
        return image;
      }
      content.push(image.value);
    }
    prepared.push({ ...message, content });
  }
  return Result.ok(prepared);
};

/** Every adapter request, including structured output and later tool iterations. */
export const withProviderImageInput = (
  adapter: AnyTextAdapter,
  provider: TanStackAIProvider,
): AnyTextAdapter => {
  // Factories create fresh adapters per turn. Nothing is retained by the shared
  // factory or across tenants; the bounded LRU dies with this adapter.
  const preparedImages: PreparedBedrockImages = {
    sources: new Map(),
    bytes: 0,
  };
  // The SDK types `model` loosely; every TanStack text adapter names a string model.
  const modelId =
    typeof adapter.model === "string"
      ? adapter.model
      : panic("A text adapter must name its model");
  const prepare = async (messages: ModelMessage[]) =>
    await prepareProviderImageMessages({
      messages,
      modelId,
      provider,
      preparedImages,
    });
  const chatStream: AnyTextAdapter["chatStream"] = async function* (options) {
    const messages = await prepare(options.messages);
    if (Result.isError(messages)) {
      yield runError(modelId, messages.error);
      return;
    }
    yield* adapter.chatStream({ ...options, messages: messages.value });
  };
  const structuredOutput: AnyTextAdapter["structuredOutput"] = async (
    options,
  ) => {
    const messages = await prepare(options.chatOptions.messages);
    if (Result.isError(messages)) {
      // TanStack's non-streaming contract requires a rejected Promise, not Result.
      return await Promise.reject(messages.error);
    }
    return await adapter.structuredOutput({
      ...options,
      chatOptions: { ...options.chatOptions, messages: messages.value },
    });
  };
  const originalStream = adapter.structuredOutputStream;
  const structuredOutputStream: AnyTextAdapter["structuredOutputStream"] =
    originalStream === undefined
      ? undefined
      : async function* (options) {
          const messages = await prepare(options.chatOptions.messages);
          if (Result.isError(messages)) {
            yield runError(modelId, messages.error);
            return;
          }
          yield* originalStream.call(adapter, {
            ...options,
            chatOptions: {
              ...options.chatOptions,
              messages: messages.value,
            },
          });
        };
  return new Proxy(adapter, {
    get: (target, key) => {
      if (key === "chatStream") {
        return chatStream;
      }
      if (key === "structuredOutput") {
        return structuredOutput;
      }
      if (key === "structuredOutputStream") {
        return structuredOutputStream;
      }
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
};
