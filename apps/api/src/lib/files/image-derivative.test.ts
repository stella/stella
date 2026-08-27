import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  generateImageThumbnail,
  IMAGE_SOURCE_TOO_LARGE_CODE,
  isThumbnailableMimeType,
  shouldGenerateImageThumbnail,
} from "@/api/lib/files/image-derivative";
import { LIMITS } from "@/api/lib/limits";

describe("image thumbnail eligibility", () => {
  test("accepts only supported unencrypted image formats", () => {
    expect(shouldGenerateImageThumbnail({ mimeType: "image/jpeg" })).toBe(true);
    expect(shouldGenerateImageThumbnail({ mimeType: "image/png" })).toBe(true);
    expect(shouldGenerateImageThumbnail({ mimeType: "image/gif" })).toBe(true);
    expect(shouldGenerateImageThumbnail({ mimeType: "image/webp" })).toBe(true);

    expect(shouldGenerateImageThumbnail({ mimeType: "image/avif" })).toBe(
      false,
    );
    expect(shouldGenerateImageThumbnail({ mimeType: "image/heic" })).toBe(
      false,
    );
    expect(shouldGenerateImageThumbnail({ mimeType: "application/pdf" })).toBe(
      false,
    );
  });

  test("rejects encrypted images and prototype names", () => {
    expect(
      shouldGenerateImageThumbnail({
        encrypted: true,
        mimeType: "image/png",
      }),
    ).toBe(false);
    expect(isThumbnailableMimeType("toString")).toBe(false);
    expect(isThumbnailableMimeType("constructor")).toBe(false);
  });
});

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, Bun.hash.crc32(crcInput));
  return chunk;
};

/** A header-only PNG declaring `edge` x `edge` pixels and carrying no image
 *  data at all: only a reader that stops at the header can report its size. */
const declaredSizePng = (edge: number): Uint8Array => {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, edge);
  view.setUint32(4, edge);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunks = [
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }
  return png;
};

const ONE_PIXEL_PNG = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
);

describe("generateImageThumbnail", () => {
  test("produces a thumbnail and placeholder for a small image", async () => {
    const result = await generateImageThumbnail(ONE_PIXEL_PNG);

    expect(Result.isError(result)).toBe(false);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.webp.length).toBeGreaterThan(0);
    expect(result.value.placeholder.startsWith("data:image/png;base64,")).toBe(
      true,
    );
  });

  test("refuses a source declaring more pixels than the decode budget", async () => {
    const edge = Math.ceil(
      Math.sqrt(LIMITS.imageDerivativeSourcePixelsMax) + 1000,
    );
    const result = await generateImageThumbnail(declaredSizePng(edge));

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe(IMAGE_SOURCE_TOO_LARGE_CODE);
    }
  });
});
