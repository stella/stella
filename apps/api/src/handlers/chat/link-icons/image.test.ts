import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { isValidLinkIconImage } from "./image";

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length);
  body.copy(result, 4);
  result.writeUInt32BE(Bun.hash.crc32(body), 8 + data.length);
  return result;
};

const png = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const rows = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const ONE_PIXEL_PNG = png(1, 1);

const ico = (
  entries: { width: number; height: number; bytes: Buffer }[],
): Buffer => {
  const directoryLength = 6 + entries.length * 16;
  const result = Buffer.alloc(
    directoryLength +
      entries.reduce((total, entry) => total + entry.bytes.length, 0),
  );
  result.writeUInt16LE(1, 2);
  result.writeUInt16LE(entries.length, 4);
  let payloadOffset = directoryLength;
  let index = 0;
  for (const { width, height, bytes } of entries) {
    const offset = 6 + index * 16;
    result.writeUInt8(width === 256 ? 0 : width, offset);
    result.writeUInt8(height === 256 ? 0 : height, offset + 1);
    result.writeUInt16LE(1, offset + 4);
    result.writeUInt16LE(32, offset + 6);
    result.writeUInt32LE(bytes.length, offset + 8);
    result.writeUInt32LE(payloadOffset, offset + 12);
    bytes.copy(result, payloadOffset);
    payloadOffset += bytes.length;
    index += 1;
  }
  return result;
};

test("accepts a structurally valid PNG only under its matching MIME type", () => {
  expect(isValidLinkIconImage(ONE_PIXEL_PNG, "image/png")).toBe(true);
  expect(isValidLinkIconImage(ONE_PIXEL_PNG, "image/x-icon")).toBe(false);
});

test("rejects truncated PNG data", () => {
  expect(isValidLinkIconImage(ONE_PIXEL_PNG.subarray(0, -4), "image/png")).toBe(
    false,
  );
});

test("bounds inflated PNG data before accepting a raster", () => {
  const bytes = Buffer.concat([
    ONE_PIXEL_PNG.subarray(0, 33),
    chunk("IDAT", deflateSync(Buffer.alloc(65_537))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(isValidLinkIconImage(bytes, "image/png")).toBe(false);
});

test("rejects PNG dimensions above 256 pixels", () => {
  expect(isValidLinkIconImage(png(257, 1), "image/png")).toBe(false);
});

test("rejects PNGs whose decoded pixel data exceeds 64 KiB", () => {
  expect(isValidLinkIconImage(png(129, 128), "image/png")).toBe(false);
});

test("accepts a one-entry PNG-backed ICO", () => {
  expect(
    isValidLinkIconImage(
      ico([{ width: 1, height: 1, bytes: ONE_PIXEL_PNG }]),
      "image/x-icon",
    ),
  ).toBe(true);
});

test("accepts an uncompressed 32-bit DIB ICO entry", () => {
  const dib = Buffer.alloc(48);
  dib.writeUInt32LE(40);
  dib.writeInt32LE(1, 4);
  dib.writeInt32LE(2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  expect(
    isValidLinkIconImage(
      ico([{ width: 1, height: 1, bytes: dib }]),
      "image/x-icon",
    ),
  ).toBe(true);
});

test("bounds aggregate decoded work across repeated ICO entries", () => {
  const image = png(90, 90);
  expect(
    isValidLinkIconImage(
      ico([
        { width: 90, height: 90, bytes: image },
        { width: 90, height: 90, bytes: image },
      ]),
      "image/x-icon",
    ),
  ).toBe(false);
});

test("rejects images larger than the wire limit", () => {
  expect(isValidLinkIconImage(Buffer.alloc(64 * 1024 + 1), "image/png")).toBe(
    false,
  );
});

test("rejects SVG markup regardless of its declared image type", () => {
  expect(
    isValidLinkIconImage(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "image/png",
    ),
  ).toBe(false);
});
