import { Result } from "better-result";
import { inflateSync } from "node:zlib";

const MAX_IMAGE_BYTES = 64 * 1024;
const MAX_DIMENSION = 256;
const MAX_DECODED_BYTES = 64 * 1024;
const MAX_ICO_ENTRIES = 16;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const ICO_SIGNATURE = Buffer.from([0, 0, 1, 0]);

type DecodedImage = { width: number; height: number; decodedBytes: number };
type PngHeader = { width: number; height: number; channels: number };

const readPngHeader = (data: Buffer): PngHeader | null => {
  if (data.length !== 13) {
    return null;
  }
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data.readUInt8(8);
  const colorType = data.readUInt8(9);
  let channels: number;
  switch (colorType) {
    case 0:
      channels = 1;
      break;
    case 2:
      channels = 3;
      break;
    case 4:
      channels = 2;
      break;
    case 6:
      channels = 4;
      break;
    default:
      return null;
  }
  if (
    width < 1 ||
    width > MAX_DIMENSION ||
    height < 1 ||
    height > MAX_DIMENSION ||
    bitDepth !== 8 ||
    data[10] !== 0 ||
    data[11] !== 0 ||
    data[12] !== 0
  ) {
    return null;
  }
  return { width, height, channels };
};

const validPng = (bytes: Buffer): DecodedImage | null => {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  const imageData: Buffer[] = [];
  let imageDataLength = 0;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (length > MAX_IMAGE_BYTES || chunkEnd > bytes.length) {
      return null;
    }
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      Bun.hash.crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    ) {
      return null;
    }

    if (!sawHeader) {
      if (type !== "IHDR") {
        return null;
      }
      const header = readPngHeader(data);
      if (!header) {
        return null;
      }
      ({ width, height, channels } = header);
      sawHeader = true;
    } else if (type === "IDAT") {
      if (sawEnd) {
        return null;
      }
      sawData = true;
      imageDataLength += length;
      if (imageDataLength > MAX_IMAGE_BYTES) {
        return null;
      }
      imageData.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !sawData || chunkEnd !== bytes.length) {
        return null;
      }
      sawEnd = true;
      break;
    } else {
      // Only the essential PNG chunks are accepted; metadata and extensions are outside this format subset.
      return null;
    }
    offset = chunkEnd;
  }

  if (!sawHeader || !sawData || !sawEnd) {
    return null;
  }
  const pixelBytes = width * height * 4;
  const decodedLength = height * (1 + width * channels);
  if (pixelBytes + decodedLength > MAX_DECODED_BYTES) {
    return null;
  }
  const inflated = Result.try(() =>
    inflateSync(Buffer.concat(imageData), { maxOutputLength: decodedLength }),
  );
  if (inflated.isErr() || inflated.value.length !== decodedLength) {
    return null;
  }
  for (let row = 0; row < height; row += 1) {
    if (inflated.value.readUInt8(row * (1 + width * channels)) > 4) {
      return null;
    }
  }
  return { width, height, decodedBytes: pixelBytes + decodedLength };
};

type DibOptions = {
  bytes: Buffer;
  expectedWidth: number;
  expectedHeight: number;
};

const validDib = ({
  bytes,
  expectedWidth,
  expectedHeight,
}: DibOptions): DecodedImage | null => {
  if (bytes.length < 48 || bytes.readUInt32LE(0) !== 40) {
    return null;
  }
  const width = bytes.readInt32LE(4);
  const doubledHeight = bytes.readInt32LE(8);
  const planes = bytes.readUInt16LE(12);
  const bitsPerPixel = bytes.readUInt16LE(14);
  const compression = bytes.readUInt32LE(16);
  const imageSize = bytes.readUInt32LE(20);
  const colorsUsed = bytes.readUInt32LE(32);
  const colorsImportant = bytes.readUInt32LE(36);
  if (
    width !== expectedWidth ||
    doubledHeight <= 0 ||
    doubledHeight % 2 !== 0 ||
    doubledHeight / 2 !== expectedHeight ||
    planes !== 1 ||
    (bitsPerPixel !== 24 && bitsPerPixel !== 32) ||
    compression !== 0 ||
    colorsUsed !== 0 ||
    colorsImportant !== 0
  ) {
    return null;
  }

  const xorStride = Math.ceil((width * bitsPerPixel) / 32) * 4;
  const andStride = Math.ceil(width / 32) * 4;
  const xorBytes = xorStride * expectedHeight;
  const andBytes = andStride * expectedHeight;
  const pixelBytes = width * expectedHeight * 4;
  if (
    (imageSize !== 0 && imageSize !== xorBytes) ||
    40 + xorBytes + andBytes !== bytes.length ||
    pixelBytes + xorBytes + andBytes > MAX_DECODED_BYTES
  ) {
    return null;
  }
  return {
    width,
    height: expectedHeight,
    decodedBytes: pixelBytes + xorBytes + andBytes,
  };
};

/** Accepts bounded PNGs and ICO containers with bounded PNG or BI_RGB DIB entries. */
export const isValidLinkIconImage = (
  input: Uint8Array,
  contentType: string,
): boolean => {
  if (input.byteLength === 0 || input.byteLength > MAX_IMAGE_BYTES) {
    return false;
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (contentType === "image/png") {
    return validPng(bytes) !== null;
  }
  if (
    contentType !== "image/x-icon" &&
    contentType !== "image/vnd.microsoft.icon"
  ) {
    return false;
  }
  if (bytes.length < 22 || !bytes.subarray(0, 4).equals(ICO_SIGNATURE)) {
    return false;
  }

  const count = bytes.readUInt16LE(4);
  if (count === 0 || count > MAX_ICO_ENTRIES || 6 + count * 16 > bytes.length) {
    return false;
  }
  let decodedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const widthByte = bytes.readUInt8(entry);
    const heightByte = bytes.readUInt8(entry + 1);
    const width = widthByte === 0 ? 256 : widthByte;
    const height = heightByte === 0 ? 256 : heightByte;
    const length = bytes.readUInt32LE(entry + 8);
    const start = bytes.readUInt32LE(entry + 12);
    if (
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      length === 0 ||
      start < 6 + count * 16 ||
      start + length > bytes.length
    ) {
      return false;
    }
    const payload = bytes.subarray(start, start + length);
    const image = payload.subarray(0, 8).equals(PNG_SIGNATURE)
      ? validPng(payload)
      : validDib({
          bytes: payload,
          expectedWidth: width,
          expectedHeight: height,
        });
    if (!image || image.width !== width || image.height !== height) {
      return false;
    }
    decodedBytes += image.decodedBytes;
    if (decodedBytes > MAX_DECODED_BYTES) {
      return false;
    }
  }
  return true;
};
