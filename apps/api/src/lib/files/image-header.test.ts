import { describe, expect, test } from "bun:test";

import type { HeaderReadableImageMimeType } from "@/api/lib/files/image-header";
import { readImageHeader } from "@/api/lib/files/image-header";

const bytesOf = (
  size: number,
  write: (view: DataView, bytes: Uint8Array) => void,
) => {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer), bytes);
  return bytes;
};

const ascii = (bytes: Uint8Array, offset: number, text: string) => {
  bytes.set(new TextEncoder().encode(text), offset);
};

const png = (width: number, height: number) =>
  bytesOf(33, (view, bytes) => {
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    view.setUint32(8, 13);
    ascii(bytes, 12, "IHDR");
    view.setUint32(16, width);
    view.setUint32(20, height);
  });

/** SOI, an EXIF APP1 with `orientation`, a padded APP0, then SOF2. */
const jpeg = (width: number, height: number, orientation: number) =>
  bytesOf(70, (view, bytes) => {
    bytes.set([0xff, 0xd8], 0);
    // APP1: length 34 = 2 + "Exif\0\0" (6) + TIFF (26: header, one-entry
    // directory, next-directory offset).
    bytes.set([0xff, 0xe1], 2);
    view.setUint16(4, 34);
    ascii(bytes, 6, "Exif\0\0");
    ascii(bytes, 12, "II");
    view.setUint16(14, 42, true);
    view.setUint32(16, 8, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 0x01_12, true);
    view.setUint16(24, 3, true);
    view.setUint32(26, 1, true);
    view.setUint16(30, orientation, true);
    // Fill byte before the next marker, which readers must skip.
    bytes[38] = 0xff;
    bytes.set([0xff, 0xe0], 39);
    view.setUint16(41, 16);
    // SOF2 (progressive).
    bytes.set([0xff, 0xc2], 57);
    view.setUint16(59, 11);
    bytes[61] = 8;
    view.setUint16(62, height);
    view.setUint16(64, width);
  });

const gif = (width: number, height: number) =>
  bytesOf(13, (view, bytes) => {
    ascii(bytes, 0, "GIF89a");
    view.setUint16(6, width, true);
    view.setUint16(8, height, true);
  });

const bmp = (width: number, height: number) =>
  bytesOf(54, (view, bytes) => {
    ascii(bytes, 0, "BM");
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
  });

const webpVp8x = (width: number, height: number) =>
  bytesOf(30, (view, bytes) => {
    ascii(bytes, 0, "RIFF");
    ascii(bytes, 8, "WEBP");
    ascii(bytes, 12, "VP8X");
    view.setUint32(24, width - 1, true);
    // Height-1 is the 24-bit field at 27; byte 30 would be the next chunk.
    bytes[27] = (height - 1) % 256;
    bytes[28] = Math.floor((height - 1) / 256) % 256;
    bytes[29] = Math.floor((height - 1) / 65_536);
  });

const webpLossless = (width: number, height: number) =>
  bytesOf(30, (view, bytes) => {
    ascii(bytes, 0, "RIFF");
    ascii(bytes, 8, "WEBP");
    ascii(bytes, 12, "VP8L");
    bytes[20] = 0x2f;
    view.setUint32(21, width - 1 + (height - 1) * 0x40_00, true);
  });

/** A two-page big-endian TIFF; the second page is the larger one. */
const tiff = () =>
  bytesOf(8 + 2 + 24 + 4 + 2 + 24 + 4, (view, bytes) => {
    ascii(bytes, 0, "MM");
    view.setUint16(2, 42);
    view.setUint32(4, 8);
    const directory = (
      offset: number,
      width: number,
      height: number,
      next: number,
    ) => {
      view.setUint16(offset, 2);
      view.setUint16(offset + 2, 0x01_00);
      view.setUint16(offset + 4, 4);
      view.setUint32(offset + 6, 1);
      view.setUint32(offset + 10, width);
      view.setUint16(offset + 14, 0x01_01);
      view.setUint16(offset + 16, 3);
      view.setUint32(offset + 18, 1);
      view.setUint16(offset + 22, height);
      view.setUint32(offset + 26, next);
    };
    directory(8, 100, 50, 38);
    directory(38, 3000, 4000, 0);
  });

const CASES = [
  { mimeType: "image/png", bytes: png(4000, 3000), expected: [4000, 3000, 1] },
  {
    mimeType: "image/jpeg",
    bytes: jpeg(4032, 3024, 6),
    expected: [4032, 3024, 6],
  },
  { mimeType: "image/gif", bytes: gif(640, 480), expected: [640, 480, 1] },
  { mimeType: "image/bmp", bytes: bmp(800, -600), expected: [800, 600, 1] },
  {
    mimeType: "image/webp",
    bytes: webpVp8x(10_000, 9000),
    expected: [10_000, 9000, 1],
  },
  {
    mimeType: "image/webp",
    bytes: webpLossless(1234, 5678),
    expected: [1234, 5678, 1],
  },
  { mimeType: "image/tiff", bytes: tiff(), expected: [3000, 4000, 1] },
] as const satisfies readonly {
  mimeType: HeaderReadableImageMimeType;
  bytes: Uint8Array;
  expected: readonly [number, number, number];
}[];

describe("image header dimensions", () => {
  test.each(CASES)(
    "reads $mimeType dimensions from the header alone",
    ({ bytes, expected, mimeType }) => {
      expect(readImageHeader(bytes, mimeType)).toEqual({
        width: expected[0],
        height: expected[1],
        orientation: expected[2],
      });
    },
  );

  test.each(CASES)(
    "a truncated $mimeType header is unreadable, never a wrong size or a throw",
    ({ bytes, mimeType }) => {
      const full = readImageHeader(bytes, mimeType);
      for (let length = 0; length < bytes.length; length += 1) {
        const partial = readImageHeader(bytes.subarray(0, length), mimeType);
        if (partial !== null) {
          expect(partial.width * partial.height).toBeLessThanOrEqual(
            (full?.width ?? 0) * (full?.height ?? 0),
          );
        }
      }
    },
  );

  test("a file of another type is unreadable", () => {
    expect(readImageHeader(gif(1, 1), "image/png")).toBeNull();
    expect(readImageHeader(png(1, 1), "image/jpeg")).toBeNull();
    expect(readImageHeader(new Uint8Array(64), "image/tiff")).toBeNull();
  });

  test("a TIFF whose directories loop is unreadable", () => {
    const looping = tiff();
    new DataView(looping.buffer).setUint32(64, 8);
    expect(readImageHeader(looping, "image/tiff")).toBeNull();
  });
});
