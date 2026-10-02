import type { AnyTextAdapter, ModelMessage } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { BYOK_MODEL_OPTIONS, TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import {
  BEDROCK_IMAGE_MAX_BYTES,
  prepareProviderImageMessages,
  withProviderImageInput,
} from "@/api/lib/chat/provider-image-input";
import { getModelImageCapability } from "@/api/lib/chat/sdk-image-capability";
import { toDataUrl } from "@/api/lib/data-url";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const PNG = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
);
const imageMessages = (bytes: Uint8Array = PNG) =>
  [
    {
      role: "user",
      content: [
        { type: "text", content: "Read this image." },
        {
          type: "image",
          source: { type: "url", value: toDataUrl(bytes, "image/png") },
        },
      ],
    },
  ] satisfies ModelMessage[];
const prepareImages = async (
  options: Parameters<typeof prepareProviderImageMessages>[0],
) => Result.unwrap(await prepareProviderImageMessages(options));

const TEXT: ModelMessage[] = [{ role: "user", content: "Read this text." }];

describe("image input preparation", () => {
  test("every offered model accepts or records unknown images, refuses explicit incompatibility, and accepts text", async () => {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const modelId of [
        ...BYOK_MODEL_OPTIONS[provider],
        "unknown-model",
      ]) {
        expect(
          await prepareImages({
            messages: TEXT,
            provider,
            modelId,
          }),
        ).toBe(TEXT);
        const messages = imageMessages();
        if (getModelImageCapability({ provider, modelId }) !== "unsupported") {
          expect(await prepareImages({ messages, provider, modelId })).toEqual(
            messages,
          );
          continue;
        }
        await expect(
          prepareProviderImageMessages({ messages, provider, modelId }),
        ).resolves.toMatchObject({
          status: "error",
          error: {
            _tag: "HandlerError",
            code: "image_input_unsupported",
            status: 422,
          },
        });
      }
    }
  });

  test("unknown image capability proceeds with an observable log field", async () => {
    const telemetry = installRecordingLogger();
    try {
      const messages = imageMessages();
      for (const provider of TANSTACK_AI_PROVIDERS) {
        expect(
          getModelImageCapability({ provider, modelId: "unknown-model" }),
        ).toBe("unknown");
        expect(
          await prepareImages({
            messages,
            provider,
            modelId: "unknown-model",
          }),
        ).toEqual(messages);
      }
      expect(
        telemetry.records
          .filter(
            ({ attributes }) =>
              attributes?.["image_capability_unknown"] === true,
          )
          .map(({ attributes }) => attributes?.["provider"]),
      ).toEqual([...TANSTACK_AI_PROVIDERS]);
      telemetry.records.length = 0;
      await prepareImages({
        messages: TEXT,
        provider: "openai",
        modelId: "unknown-model",
      });
      expect(telemetry.records).toEqual([]);
    } finally {
      telemetry.restore();
    }
  });

  test("conflicting sources preserve images and log the unknown reason", async () => {
    const telemetry = installRecordingLogger();
    try {
      const messages = imageMessages();
      expect(
        getModelImageCapability({
          provider: "mistral",
          modelId: "mistral-large-latest",
        }),
      ).toBe("unknown");
      expect(
        await prepareImages({
          messages,
          provider: "mistral",
          modelId: "mistral-large-latest",
        }),
      ).toBe(messages);
      expect(telemetry.records).toContainEqual(
        expect.objectContaining({
          message: "ai.image_capability_unknown",
          attributes: expect.objectContaining({
            provider: "mistral",
            image_capability_unknown: true,
            reason: "conflicting_sources",
          }),
        }),
      );
    } finally {
      telemetry.restore();
    }
  });

  test("Bedrock bounds encoded bytes, preserves originals within the limit, and leaves other providers unchanged", async () => {
    for (const size of [
      BEDROCK_IMAGE_MAX_BYTES,
      BEDROCK_IMAGE_MAX_BYTES + 1,
      FILE_SIZE_LIMIT_BYTES.chatContextFile,
    ]) {
      const bytes = new Uint8Array(size);
      bytes.set(PNG);
      const messages = imageMessages(bytes);
      const result = await prepareImages({
        messages,
        provider: "bedrock",
        modelId: "us.amazon.nova-lite-v1:0",
      });
      const content = result.at(0)?.content;
      expect(Array.isArray(content)).toBe(true);
      if (!Array.isArray(content)) {
        throw new TypeError("Expected image content");
      }
      const image = content.at(1);
      expect(image?.type).toBe("image");
      if (image?.type !== "image") {
        throw new TypeError("Expected image");
      }
      if (size <= BEDROCK_IMAGE_MAX_BYTES) {
        const original = messages.at(0)?.content;
        if (!Array.isArray(original)) {
          throw new TypeError("Expected original image content");
        }
        const originalImage = original.at(1);
        if (originalImage?.type !== "image") {
          throw new TypeError("Expected the original image part");
        }
        expect(image).toEqual(originalImage);
      } else {
        expect(image.source).toMatchObject({
          type: "data",
          mimeType: "image/webp",
        });
        const encoded = Buffer.from(image.source.value, "base64");
        expect(encoded.byteLength).toBeLessThanOrEqual(BEDROCK_IMAGE_MAX_BYTES);
        expect(await new Bun.Image(encoded).metadata()).toMatchObject({
          width: 1,
          height: 1,
        });
      }
      expect(
        await prepareImages({
          messages,
          provider: "openai",
          modelId: "gpt-5.2",
        }),
      ).toBe(messages);
    }
  });

  test("Bedrock bounds image dimensions even below its byte limit", async () => {
    const bytes = await new Bun.Image(PNG)
      .resize(8001, 1, { fit: "fill" })
      .png()
      .bytes();
    expect(bytes.byteLength).toBeLessThan(BEDROCK_IMAGE_MAX_BYTES);
    expect(await new Bun.Image(bytes).metadata()).toMatchObject({
      width: 8001,
    });
    const result = await prepareImages({
      messages: imageMessages(bytes),
      provider: "bedrock",
      modelId: "us.amazon.nova-lite-v1:0",
    });
    const content = result.at(0)?.content;
    if (!Array.isArray(content)) {
      throw new TypeError("Expected image content");
    }
    const image = content.at(1);
    if (image?.type !== "image") {
      throw new TypeError("Expected image");
    }
    expect(
      await new Bun.Image(Buffer.from(image.source.value, "base64")).metadata(),
    ).toMatchObject({ width: 2048, height: 1 });
  });

  test("Bedrock preserves EXIF orientation when re-encoding an oversized image", async () => {
    const jpeg = await new Bun.Image(PNG)
      .resize(2, 3, { fit: "fill" })
      .jpeg()
      .bytes();
    // JPEG APP1 with TIFF Orientation=6 (90 degrees clockwise).
    const exif = Uint8Array.from([
      0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1,
      0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const bytes = new Uint8Array(BEDROCK_IMAGE_MAX_BYTES + 1);
    bytes.set(jpeg.subarray(0, 2));
    bytes.set(exif, 2);
    bytes.set(jpeg.subarray(2), 2 + exif.length);
    const oriented = await new Bun.Image(bytes, { autoOrient: true })
      .webp()
      .bytes();
    expect(await new Bun.Image(oriented).metadata()).toMatchObject({
      width: 3,
      height: 2,
    });
    const result = await prepareImages({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "data",
                value: Buffer.from(bytes).toString("base64"),
                mimeType: "image/jpeg",
              },
            },
          ],
        },
      ],
      provider: "bedrock",
      modelId: "us.amazon.nova-lite-v1:0",
    });
    const content = result.at(0)?.content;
    if (!Array.isArray(content)) {
      throw new TypeError("Expected image content");
    }
    const image = content.at(0);
    if (image?.type !== "image") {
      throw new TypeError("Expected image");
    }
    expect(
      await new Bun.Image(Buffer.from(image.source.value, "base64")).metadata(),
    ).toMatchObject({ width: 3, height: 2 });
  });

  test("Bedrock refuses an encoder result that still exceeds its byte limit", async () => {
    const source = new Uint8Array(BEDROCK_IMAGE_MAX_BYTES + 1);
    source.set(PNG);
    const encode = spyOn(Bun.Image.prototype, "bytes").mockResolvedValue(
      new Uint8Array(BEDROCK_IMAGE_MAX_BYTES + 1),
    );
    try {
      await expect(
        prepareProviderImageMessages({
          messages: imageMessages(source),
          provider: "bedrock",
          modelId: "us.amazon.nova-lite-v1:0",
        }),
      ).resolves.toMatchObject({
        status: "error",
        error: {
          _tag: "HandlerError",
          code: "bedrock_image_invalid",
          status: 422,
        },
      });
      expect(encode).toHaveBeenCalledTimes(1);
    } finally {
      encode.mockRestore();
    }
  });

  test("Bedrock refuses unreadable oversized images with a typed actionable error", async () => {
    const bytes = new Uint8Array(BEDROCK_IMAGE_MAX_BYTES + 1);
    await expect(
      prepareProviderImageMessages({
        messages: imageMessages(bytes),
        provider: "bedrock",
        modelId: "us.amazon.nova-lite-v1:0",
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: {
        _tag: "HandlerError",
        code: "bedrock_image_invalid",
        status: 422,
      },
    });
  });

  test("Bedrock re-encodes each content identity once across adapter iterations and isolates turns", async () => {
    const first = new Uint8Array(BEDROCK_IMAGE_MAX_BYTES + 1);
    first.set(PNG);
    const second = new Uint8Array(BEDROCK_IMAGE_MAX_BYTES + 1);
    second.set(
      await new Bun.Image(PNG).resize(2, 1, { fit: "fill" }).png().bytes(),
    );
    const sent: ModelMessage[][] = [];
    const makeAdapter = () =>
      withProviderImageInput(
        asTestRaw<AnyTextAdapter>({
          kind: "text",
          name: "fixture",
          model: "us.amazon.nova-lite-v1:0",
          async *chatStream({
            messages,
          }: Parameters<AnyTextAdapter["chatStream"]>[0]) {
            sent.push(messages);
            yield* [];
          },
          structuredOutput: async ({
            chatOptions,
          }: Parameters<AnyTextAdapter["structuredOutput"]>[0]) => {
            sent.push(chatOptions.messages);
            return { data: {}, rawText: "{}" };
          },
        }),
        "bedrock",
      );
    const encode = spyOn(Bun.Image.prototype, "bytes");
    try {
      const adapter = makeAdapter();
      for (let iteration = 0; iteration < 5; iteration++) {
        // Rehydrated objects still share an attachment's content identity.
        for await (const _ of adapter.chatStream({
          model: adapter.model,
          messages: imageMessages(first),
          logger: resolveDebugOption(false),
        })) {
          /* Consume the request. */
        }
      }
      expect(encode).toHaveBeenCalledTimes(1);
      for (const bytes of [second, first, second]) {
        await adapter.structuredOutput({
          chatOptions: {
            model: adapter.model,
            messages: imageMessages(bytes),
            logger: resolveDebugOption(false),
          },
          outputSchema: { type: "object" },
        });
      }
      expect(encode).toHaveBeenCalledTimes(2);
      expect(sent.at(0)).toEqual(sent.at(4));
      expect(sent.at(5)).not.toEqual(sent.at(0));
      const nextTurn = makeAdapter();
      for await (const _ of nextTurn.chatStream({
        model: nextTurn.model,
        messages: imageMessages(first),
        logger: resolveDebugOption(false),
      })) {
        /* Consume the request. */
      }
      expect(encode).toHaveBeenCalledTimes(3);
    } finally {
      encode.mockRestore();
    }
  });

  test("Bedrock prepared-image retention is bounded and evicts the least recently used source", async () => {
    const wide = await new Bun.Image(PNG)
      .resize(8001, 1, { fit: "fill" })
      .png()
      .bytes();
    const originals = [0, 1, 2, 3].map((identity) => {
      const bytes = new Uint8Array(wide.byteLength + 1);
      bytes.set(wide);
      bytes[wide.byteLength] = identity;
      return bytes;
    });
    const adapter = withProviderImageInput(
      asTestRaw<AnyTextAdapter>({
        kind: "text",
        name: "fixture",
        model: "us.amazon.nova-lite-v1:0",
        async *chatStream() {
          yield* [];
        },
      }),
      "bedrock",
    );
    // Worst-case permitted output exercises the byte budget, not just count.
    const encode = spyOn(Bun.Image.prototype, "bytes").mockResolvedValue(
      new Uint8Array(BEDROCK_IMAGE_MAX_BYTES),
    );
    const request = async (bytes: Uint8Array) => {
      for await (const _ of adapter.chatStream({
        model: adapter.model,
        messages: imageMessages(bytes),
        logger: resolveDebugOption(false),
      })) {
        /* Consume the request. */
      }
    };
    try {
      for (const original of originals.slice(0, 3)) {
        await request(original);
      }
      expect(encode).toHaveBeenCalledTimes(3);
      const first = originals.at(0);
      const second = originals.at(1);
      const fourth = originals.at(3);
      if (first === undefined || second === undefined || fourth === undefined) {
        throw new TypeError("Expected four image identities");
      }
      await request(first);
      expect(encode).toHaveBeenCalledTimes(3);
      await request(fourth);
      await request(first);
      expect(encode).toHaveBeenCalledTimes(4);
      await request(second);
      expect(encode).toHaveBeenCalledTimes(5);
    } finally {
      encode.mockRestore();
    }
  });

  test("all adapter request forms refuse unsupported images before dispatch and still send text", async () => {
    const sent: ModelMessage[][] = [];
    const raw = asTestRaw<AnyTextAdapter>({
      kind: "text",
      name: "fixture",
      model: "us.amazon.nova-micro-v1:0",
      async *chatStream({
        messages,
      }: Parameters<AnyTextAdapter["chatStream"]>[0]) {
        sent.push(messages);
        yield* [];
      },
      structuredOutput: async ({
        chatOptions,
      }: Parameters<AnyTextAdapter["structuredOutput"]>[0]) => {
        sent.push(chatOptions.messages);
        return { data: {}, rawText: "{}" };
      },
      async *structuredOutputStream({
        chatOptions,
      }: Parameters<NonNullable<AnyTextAdapter["structuredOutputStream"]>>[0]) {
        sent.push(chatOptions.messages);
        yield* [];
      },
    });
    const adapter = withProviderImageInput(raw, "bedrock");
    for (const messages of [imageMessages(), TEXT]) {
      const chatOptions = {
        model: raw.model,
        messages,
        logger: resolveDebugOption(false),
      };
      const structuredOptions = {
        chatOptions,
        outputSchema: { type: "object" },
      };
      const consume = async (stream: AsyncIterable<unknown>) => {
        const chunks: unknown[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        return chunks;
      };
      const calls = [
        () => consume(adapter.chatStream(chatOptions)),
        () => adapter.structuredOutput(structuredOptions),
        () => {
          if (adapter.structuredOutputStream === undefined) {
            throw new TypeError("Expected structured stream");
          }
          return consume(adapter.structuredOutputStream(structuredOptions));
        },
      ];
      if (messages === TEXT) {
        for (const call of calls) {
          await call();
        }
      } else {
        for (const [index, call] of calls.entries()) {
          if (index === 1) {
            await expect(call()).rejects.toBeInstanceOf(HandlerError);
            continue;
          }
          expect(await call()).toMatchObject([
            { type: "RUN_ERROR", code: "image_input_unsupported" },
          ]);
        }
      }
      expect(sent.length).toBe(messages === TEXT ? 3 : 0);
    }
  });
});
