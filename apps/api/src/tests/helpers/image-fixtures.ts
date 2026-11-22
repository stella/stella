import { deflateSync } from "node:zlib";

import type { ImageOrientation } from "@/api/lib/files/image-header";

const RED = [255, 0, 0] as const;
const BLUE = [0, 0, 255] as const;

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

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const ihdrChunk = ({
  bitDepth,
  colorType,
  height,
  interlaced,
  width,
}: {
  bitDepth: number;
  colorType: number;
  height: number;
  interlaced: boolean;
  width: number;
}) => {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlaced ? 1 : 0;
  return pngChunk("IHDR", ihdr);
};

/** 8-bit PNG colour types {@link splitPng} can write. */
type SplitPngColor = "rgb" | "rgba" | "palette";

const SPLIT_PNG_LAYOUT = {
  rgb: { colorType: 2, channels: 3 },
  rgba: { colorType: 6, channels: 4 },
  palette: { colorType: 3, channels: 1 },
} as const satisfies Record<
  SplitPngColor,
  { colorType: number; channels: number }
>;

/** An 8-bit PNG whose left half is red and right half blue. */
export const splitPng = (
  width: number,
  height: number,
  color: SplitPngColor = "rgb",
): Uint8Array => {
  const { channels, colorType } = SPLIT_PNG_LAYOUT[color];
  const pixel = (left: boolean): readonly number[] => {
    if (color === "palette") {
      return [left ? 0 : 1];
    }
    const rgb = left ? RED : BLUE;
    return color === "rgba" ? [...rgb, 255] : rgb;
  };
  const stride = 1 + width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rows.set(pixel(x < width / 2), y * stride + 1 + x * channels);
    }
  }
  return concat([
    PNG_SIGNATURE,
    ihdrChunk({ bitDepth: 8, colorType, height, interlaced: false, width }),
    ...(color === "palette"
      ? [pngChunk("PLTE", Uint8Array.from([...RED, ...BLUE]))]
      : []),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
};

/**
 * A 16-bit RGB PNG whose left half is red and right half blue: an encoding
 * the direct embedder does not take.
 */
export const sixteenBitPng = (width: number, height: number): Uint8Array => {
  const channels = 3;
  const stride = 1 + width * channels * 2;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = x < width / 2 ? RED : BLUE;
      // Each 16-bit sample is its 8-bit value repeated, big-endian.
      rows.set(
        [red, red, green, green, blue, blue],
        y * stride + 1 + x * channels * 2,
      );
    }
  }
  return concat([
    PNG_SIGNATURE,
    ihdrChunk({ bitDepth: 16, colorType: 2, height, interlaced: false, width }),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
};

/**
 * A PNG header with no image data: only its IHDR fields are meaningful, so
 * a decoder handed it fails while a header reader sees every field.
 */
export const declaredPng = ({
  bitDepth = 8,
  colorType = 2,
  height,
  interlaced = false,
  width,
}: {
  bitDepth?: number;
  colorType?: number;
  height: number;
  interlaced?: boolean;
  width: number;
}): Uint8Array =>
  concat([
    PNG_SIGNATURE,
    ihdrChunk({ bitDepth, colorType, height, interlaced, width }),
    pngChunk("IEND", new Uint8Array(0)),
  ]);

/** A PNG header declaring `width` x `height` with no image data at all. */
export const declaredSizePng = (width: number, height: number): Uint8Array =>
  declaredPng({ width, height });

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

/**
 * `jpeg` with its frame header's component count rewritten, so the header
 * declares e.g. four components (CMYK) over the same scan data.
 */
export const withJpegComponents = (
  jpeg: Uint8Array,
  components: number,
): Uint8Array => {
  const copy = jpeg.slice();
  for (let offset = 2; offset + 9 < copy.length;) {
    const marker = copy[offset + 1] ?? 0;
    const length = (copy[offset + 2] ?? 0) * 256 + (copy[offset + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xc2) {
      copy[offset + 9] = components;
      return copy;
    }
    offset += 2 + length;
  }
  return copy;
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

/** {@link splitPng} as a lossless WebP. */
export const splitWebp = async (
  width: number,
  height: number,
): Promise<Uint8Array> => {
  Bun.Image.backend = "bun";
  return await new Bun.Image(splitPng(width, height))
    .webp({ lossless: true })
    .bytes();
};

/** A 24-bit bottom-up BMP whose left half is red and right half blue. */
export const splitBmp = (width: number, height: number): Uint8Array => {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + stride * height;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d], 0);
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, stride * height, true);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = x < width / 2 ? RED : BLUE;
      // BMP stores blue, green, red.
      bytes.set([blue, green, red], 54 + y * stride + x * 3);
    }
  }
  return bytes;
};

/**
 * GIF LZW data for `indices` (2-colour palette, minimum code size 2), with a
 * clear code before the code width would grow, so every code is 3 bits.
 */
const gifImageData = (indices: readonly number[]): Uint8Array => {
  const clear = 4;
  const end = 5;
  const codes: number[] = [];
  // After a clear, the next code is 6; 3-bit codes reach 7, so two literal
  // codes fit before the table would need a fourth bit.
  for (const [index, value] of indices.entries()) {
    if (index % 2 === 0) {
      codes.push(clear);
    }
    codes.push(value);
  }
  codes.push(end);
  const packed: number[] = [];
  let buffer = 0;
  let bits = 0;
  // Codes are packed least significant bit first.
  for (const code of codes) {
    buffer += code * 2 ** bits;
    bits += 3;
    while (bits >= 8) {
      packed.push(buffer % 256);
      buffer = Math.floor(buffer / 256);
      bits -= 8;
    }
  }
  if (bits > 0) {
    packed.push(buffer % 256);
  }
  const blocks: number[] = [2];
  for (let offset = 0; offset < packed.length; offset += 255) {
    const block = packed.slice(offset, offset + 255);
    blocks.push(block.length, ...block);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
};

/**
 * A GIF89a of `frames` frames, the first split red | blue and every later
 * one solid blue, so a decoder that shows any frame but the first is seen.
 */
export const splitGif = (
  width: number,
  height: number,
  frames = 1,
): Uint8Array => {
  const header = new Uint8Array(13);
  header.set(new TextEncoder().encode("GIF89a"), 0);
  const view = new DataView(header.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  // Global colour table of 2 entries.
  header[10] = 0x80;
  const palette = Uint8Array.from([...RED, ...BLUE]);
  const parts: Uint8Array[] = [header, palette];
  for (let frame = 0; frame < frames; frame += 1) {
    const descriptor = new Uint8Array(10);
    descriptor[0] = 0x2c;
    const descriptorView = new DataView(descriptor.buffer);
    descriptorView.setUint16(5, width, true);
    descriptorView.setUint16(7, height, true);
    const indices: number[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        indices.push(frame === 0 && x < width / 2 ? 0 : 1);
      }
    }
    parts.push(descriptor, gifImageData(indices));
  }
  parts.push(Uint8Array.of(0x3b));
  return concat(parts);
};

type TiffPageFixture = {
  width: number;
  height: number;
  /** One RGB triple per pixel, rows top to bottom. */
  pixel: (x: number, y: number) => readonly [number, number, number];
  orientation?: ImageOrientation;
};

/**
 * An uncompressed little-endian RGB TIFF with one directory per page,
 * chained in order.
 */
export const tiffFile = (pages: readonly TiffPageFixture[]): Uint8Array => {
  const parts: Uint8Array[] = [];
  let offset = 8;
  const directories: { at: number; bytes: Uint8Array }[] = [];
  const layouts = pages.map((page) => {
    const pixels = new Uint8Array(page.width * page.height * 3);
    for (let y = 0; y < page.height; y += 1) {
      for (let x = 0; x < page.width; x += 1) {
        pixels.set(page.pixel(x, y), (y * page.width + x) * 3);
      }
    }
    const pixelsAt = offset;
    offset += pixels.length;
    const bitsAt = offset;
    offset += 6;
    return { bitsAt, page, pixels, pixelsAt };
  });
  for (const { bitsAt, page, pixels, pixelsAt } of layouts) {
    const entries: [number, number, number, number][] = [
      [256, 4, 1, page.width],
      [257, 4, 1, page.height],
      [258, 3, 3, bitsAt],
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 4, 1, pixelsAt],
      ...(page.orientation === undefined
        ? []
        : [[274, 3, 1, page.orientation] as [number, number, number, number]]),
      [277, 3, 1, 3],
      [278, 4, 1, page.height],
      [279, 4, 1, pixels.length],
    ];
    const directory = new Uint8Array(2 + entries.length * 12 + 4);
    const view = new DataView(directory.buffer);
    view.setUint16(0, entries.length, true);
    for (const [index, [tag, type, count, value]] of entries.entries()) {
      const at = 2 + index * 12;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (type === 3 && count === 1) {
        view.setUint16(at + 8, value, true);
      } else {
        view.setUint32(at + 8, value, true);
      }
    }
    directories.push({ at: offset, bytes: directory });
    offset += directory.length;
  }
  for (const [index, directory] of directories.entries()) {
    const next = directories[index + 1]?.at ?? 0;
    new DataView(directory.bytes.buffer).setUint32(
      directory.bytes.length - 4,
      next,
      true,
    );
  }
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  header.set([0x49, 0x49], 0);
  headerView.setUint16(2, 42, true);
  headerView.setUint32(4, directories[0]?.at ?? 0, true);
  parts.push(header);
  for (const { pixels } of layouts) {
    const bits = new Uint8Array(6);
    const bitsView = new DataView(bits.buffer);
    bitsView.setUint16(0, 8, true);
    bitsView.setUint16(2, 8, true);
    bitsView.setUint16(4, 8, true);
    parts.push(pixels, bits);
  }
  for (const { bytes } of directories) {
    parts.push(bytes);
  }
  return concat(parts);
};

/** A {@link tiffFile} page split red | blue. */
export const splitTiffPage = (
  width: number,
  height: number,
  orientation?: ImageOrientation,
): TiffPageFixture => ({
  width,
  height,
  pixel: (x) => (x < width / 2 ? RED : BLUE),
  ...(orientation === undefined ? {} : { orientation }),
});
