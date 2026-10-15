import { deflateSync } from "node:zlib";

import type { ImageOrientation } from "@/api/lib/files/image-header";

export const RED = [255, 0, 0] as const;
export const BLUE = [0, 0, 255] as const;

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

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** An RGB PNG whose left half is red and right half blue. */
export const splitPng = (width: number, height: number): Uint8Array => {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      rows.set(x < width / 2 ? RED : BLUE, row + 1 + x * 3);
    }
  }
  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
};

/** A PNG header declaring `width` x `height` with no image data at all. */
export const declaredSizePng = (width: number, height: number): Uint8Array => {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
};

/** An APP1 EXIF segment carrying only an Orientation tag. */
const exifOrientationSegment = (orientation: ImageOrientation): Uint8Array => {
  const tiff = new Uint8Array(26);
  const view = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d], 0);
  view.setUint16(2, 42);
  view.setUint32(4, 8);
  view.setUint16(8, 1);
  view.setUint16(10, 0x01_12);
  view.setUint16(12, 3);
  view.setUint32(14, 1);
  view.setUint16(18, orientation);
  view.setUint32(22, 0);
  const payload = concat([new TextEncoder().encode("Exif\0\0"), tiff]);
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, 0xe1], 0);
  new DataView(segment.buffer).setUint16(2, payload.length + 2);
  segment.set(payload, 4);
  return segment;
};

/** {@link splitPng} as a JPEG carrying an EXIF `orientation`. */
export const splitJpeg = async (
  width: number,
  height: number,
  orientation: ImageOrientation,
): Promise<Uint8Array> => {
  Bun.Image.backend = "bun";
  const jpeg = await new Bun.Image(splitPng(width, height))
    .jpeg({ quality: 95 })
    .bytes();
  // Splice the orientation segment in right after SOI.
  return concat([
    jpeg.subarray(0, 2),
    exifOrientationSegment(orientation),
    jpeg.subarray(2),
  ]);
};
