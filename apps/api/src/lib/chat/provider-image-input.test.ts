import type { AnyTextAdapter, ModelMessage } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
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
const imageMessages = (bytes = PNG): ModelMessage[] => [
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
];
const TEXT: ModelMessage[] = [{ role: "user", content: "Read this text." }];

describe("image input preparation", () => {
  test("every offered model accepts or records unknown images, refuses explicit incompatibility, and accepts text", async () => {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const modelId of [
        ...BYOK_MODEL_OPTIONS[provider],
        "unknown-model",
      ]) {
        expect(
          await prepareProviderImageMessages({
            messages: TEXT,
            provider,
            modelId,
          }),
        ).toBe(TEXT);
        const messages = imageMessages();
        if (getModelImageCapability({ provider, modelId }) !== "unsupported") {
          expect(
            await prepareProviderImageMessages({ messages, provider, modelId }),
          ).toEqual(messages);
          continue;
        }
        await expect(
          prepareProviderImageMessages({ messages, provider, modelId }),
        ).rejects.toMatchObject({
          _tag: "HandlerError",
          code: "image_input_unsupported",
          status: 422,
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
          await prepareProviderImageMessages({
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
      await prepareProviderImageMessages({
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
        await prepareProviderImageMessages({
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
      const result = await prepareProviderImageMessages({
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
        expect(image).toEqual(messages.at(0)?.content.at(1));
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
        await prepareProviderImageMessages({
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
    const result = await prepareProviderImageMessages({
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
    const result = await prepareProviderImageMessages({
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
      ).rejects.toMatchObject({
        _tag: "HandlerError",
        code: "bedrock_image_invalid",
        status: 422,
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
    ).rejects.toMatchObject({
      _tag: "HandlerError",
      code: "bedrock_image_invalid",
      status: 422,
    });
  });

  test("all adapter request forms refuse unsupported images before dispatch and still send text", async () => {
    const sent: ModelMessage[][] = [];
    const raw = asTestRaw<AnyTextAdapter>({
      kind: "text",
      name: "fixture",
      model: "us.amazon.nova-micro-v1:0",
      async *chatStream({ messages }) {
        sent.push(messages);
        yield* [];
      },
      structuredOutput: async ({ chatOptions }) => {
        sent.push(chatOptions.messages);
        return { data: {}, rawText: "{}" };
      },
      async *structuredOutputStream({ chatOptions }) {
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
        for await (const _ of stream) {
          /* Consume the request. */
        }
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
      for (const call of calls) {
        if (messages === TEXT) {
          await call();
          continue;
        }
        await expect(call()).rejects.toBeInstanceOf(HandlerError);
      }
      expect(sent.length).toBe(messages === TEXT ? 3 : 0);
    }
  });
});
