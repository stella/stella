import type { AnyTextAdapter, ContentPart, ModelMessage } from "@tanstack/ai";
import { panic, Result } from "better-result";

import type { TanStackAIProvider } from "@stll/ai-catalog";

import { getModelImageCapability } from "@/api/lib/chat/sdk-image-capability";
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

const prepareBedrockImage = async (
  part: Extract<ContentPart, { type: "image" }>,
): Promise<ContentPart> => {
  let payload: string;
  if (part.source.type === "url") {
    const inline = validateDataUrl({
      maxBytes: FILE_SIZE_LIMIT_BYTES.chatContextFile,
      url: part.source.value,
    });
    if (Result.isError(inline)) {
      throw invalidBedrockImage(inline.error);
    }
    payload = inline.value.payload;
  } else if (part.source.type === "data") {
    payload = part.source.value;
  } else {
    // Nothing is fetched on the model's behalf, including file references.
    throw invalidBedrockImage();
  }
  if (payload.length > MAX_IMAGE_BASE64_LENGTH) {
    throw invalidBedrockImage();
  }
  const source = Buffer.from(payload, "base64");
  if (source.byteLength > FILE_SIZE_LIMIT_BYTES.chatContextFile) {
    throw invalidBedrockImage();
  }
  Bun.Image.backend = "bun";
  const image = new Bun.Image(source, { autoOrient: true });
  const prepared = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () => {
          const { width, height } = await image.metadata();
          if (
            source.byteLength <= BEDROCK_IMAGE_MAX_BYTES &&
            width <= BEDROCK_IMAGE_MAX_EDGE &&
            height <= BEDROCK_IMAGE_MAX_EDGE
          ) {
            return part;
          }
          if (width * height > LIMITS.imageDerivativeSourcePixelsMax) {
            throw invalidBedrockImage();
          }
          // WebP preserves alpha; one bounded encode avoids repeated full decodes.
          const bytes = await image
            .resize(REENCODE_MAX_EDGE, REENCODE_MAX_EDGE, {
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 85 })
            .bytes();
          if (bytes.byteLength > BEDROCK_IMAGE_MAX_BYTES) {
            throw invalidBedrockImage();
          }
          return {
            ...part,
            source: {
              type: "data",
              value: Buffer.from(bytes).toString("base64"),
              mimeType: "image/webp",
            },
          } satisfies ContentPart;
        },
        { label: "bedrock-image", timeoutMs: LIMITS.imageDerivativeTimeoutMs },
      ),
    catch: (cause) => invalidBedrockImage(cause),
  });
  if (Result.isError(prepared)) {
    throw prepared.error;
  }
  return prepared.value;
};

type PrepareProviderImageMessagesOptions = {
  messages: ModelMessage[];
  modelId: string;
  provider: TanStackAIProvider;
};

export const prepareProviderImageMessages = async ({
  messages,
  modelId,
  provider,
}: PrepareProviderImageMessagesOptions): Promise<ModelMessage[]> => {
  const hasImages = messages.some(
    ({ content }) =>
      Array.isArray(content) && content.some((part) => part.type === "image"),
  );
  if (!hasImages) {
    return messages;
  }
  const capability = getModelImageCapability({ provider, modelId });
  switch (capability) {
    case "unsupported":
      throw imageInputUnsupportedError();
    case "unknown":
      logger.info("ai.image_capability_unknown", {
        provider,
        image_capability_unknown: true,
      });
      break;
    case "accepts":
      break;
    default:
      capability satisfies never;
      return panic(`Unhandled image capability: ${String(capability)}`);
  }
  if (provider !== "bedrock") {
    return messages;
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
      content.push(
        part.type === "image" ? await prepareBedrockImage(part) : part,
      );
    }
    prepared.push({ ...message, content });
  }
  return prepared;
};

/** Every adapter request, including structured output and later tool iterations. */
export const withProviderImageInput = (
  adapter: AnyTextAdapter,
  provider: TanStackAIProvider,
): AnyTextAdapter => {
  const prepare = (messages: ModelMessage[]) =>
    prepareProviderImageMessages({
      messages,
      modelId: adapter.model,
      provider,
    });
  const chatStream: AnyTextAdapter["chatStream"] = async function* (options) {
    yield* adapter.chatStream({
      ...options,
      messages: await prepare(options.messages),
    });
  };
  const structuredOutput: AnyTextAdapter["structuredOutput"] = async (
    options,
  ) =>
    await adapter.structuredOutput({
      ...options,
      chatOptions: {
        ...options.chatOptions,
        messages: await prepare(options.chatOptions.messages),
      },
    });
  const originalStream = adapter.structuredOutputStream;
  const structuredOutputStream: AnyTextAdapter["structuredOutputStream"] =
    originalStream === undefined
      ? undefined
      : async function* (options) {
          yield* originalStream.call(adapter, {
            ...options,
            chatOptions: {
              ...options.chatOptions,
              messages: await prepare(options.chatOptions.messages),
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
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
