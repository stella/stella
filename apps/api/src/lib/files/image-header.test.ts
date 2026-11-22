import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { HeaderReadableImageMimeType } from "@/api/lib/files/image-header";
import { readImageHeader } from "@/api/lib/files/image-header";
import {
  heicFixture,
  withHeifRotation,
} from "@/api/tests/helpers/image-fixtures";

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
    view.setUint32(16, 10, true);
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
    view.setUint32(16, 5, true);
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
  {
    mimeType: "image/heic",
    bytes: heicFixture("grid.heic"),
    expected: [1100, 700, 1],
  },
  // irot turns anticlockwise: a quarter turn shows as EXIF 8, three as 6.
  {
    mimeType: "image/heic",
    bytes: withHeifRotation(heicFixture("single.heic"), 1),
    expected: [96, 64, 8],
  },
  {
    mimeType: "image/heif",
    bytes: withHeifRotation(heicFixture("single.heic"), 2),
    expected: [96, 64, 3],
  },
  {
    mimeType: "image/heic-sequence",
    bytes: withHeifRotation(heicFixture("alpha.heic"), 3),
    expected: [300, 200, 6],
  },
] as const satisfies readonly {
  mimeType: HeaderReadableImageMimeType;
  bytes: Uint8Array;
  expected: readonly [number, number, number];
}[];

/** An ISO base media box: size, type, then `body`. */
const box = (type: string, ...body: Uint8Array[]): Uint8Array => {
  const size = 8 + body.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  ascii(out, 4, type);
  let offset = 8;
  for (const part of body) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const u8 = (...values: number[]) => Uint8Array.from(values);
const u32 = (...values: number[]) =>
  bytesOf(values.length * 4, (view) => {
    for (const [index, value] of values.entries()) {
      view.setUint32(index * 4, value);
    }
  });

/**
 * The `ftyp` and `meta` boxes of a HEIF file whose primary item 1 has the
 * given properties, associated in order; no image data follows.
 */
const heifHeader = (properties: readonly Uint8Array[], colour?: Uint8Array) => {
  const all = colour === undefined ? properties : [...properties, colour];
  return Uint8Array.from([
    ...box("ftyp", new TextEncoder().encode("heic\0\0\0\0mif1heic")),
    ...box(
      "meta",
      u32(0),
      box(
        "hdlr",
        u32(0, 0),
        new TextEncoder().encode("pict"),
        u32(0, 0, 0),
        u8(0),
      ),
      box("pitm", u32(0), u8(0, 1)),
      box(
        "iprp",
        box("ipco", ...all),
        // version 0, flags 0: one entry, item 1, one-byte indexes from 1.
        box(
          "ipma",
          u32(0, 1),
          u8(0, 1, all.length, ...all.map((_, index) => index + 1)),
        ),
      ),
    ),
  ]);
};

const ispe = (width: number, height: number) =>
  box("ispe", u32(0, width, height));
const irot = (quarterTurns: number) => box("irot", u8(quarterTurns));
const imir = (axis: number) => box("imir", u8(axis));

describe("HEIF headers", () => {
  test("reads the primary image's size and its transforms in order", () => {
    const read = (...properties: Uint8Array[]) =>
      readImageHeader(
        heifHeader([ispe(4032, 3024), ...properties]),
        "image/heic",
      );
    expect(read()).toMatchObject({ width: 4032, height: 3024, orientation: 1 });
    // imir axis 1 mirrors left to right (EXIF 2), axis 0 top to bottom (4).
    expect(read(imir(1))?.orientation).toBe(2);
    expect(read(imir(0))?.orientation).toBe(4);
    // Mirrored then turned a quarter anticlockwise: transposed (EXIF 5);
    // turned then mirrored: the other diagonal (EXIF 7).
    expect(read(imir(1), irot(1))?.orientation).toBe(5);
    expect(read(irot(1), imir(1))?.orientation).toBe(7);
    expect(read(irot(3), irot(3))?.orientation).toBe(3);
  });

  test("says whether the colour is an ICC profile", () => {
    expect(readImageHeader(heicFixture("p3.heic"), "image/heic")).toMatchObject(
      {
        encoding: { format: "heif", iccProfile: true },
      },
    );
    expect(
      readImageHeader(heicFixture("grid.heic"), "image/heic"),
    ).toMatchObject({
      encoding: { format: "heif", iccProfile: false },
    });
  });

  test("a primary item without a size is unreadable", () => {
    expect(readImageHeader(heifHeader([irot(1)]), "image/heic")).toBeNull();
  });

  test("an image sequence without a still image reads its track's size", () => {
    const tkhd = bytesOf(84, (view) => {
      // version 0: width and height in 16.16 fixed point after the matrix.
      view.setUint32(76, 1920 * 0x1_00_00);
      view.setUint32(80, 1080 * 0x1_00_00);
    });
    const sequence = Uint8Array.from([
      ...box("ftyp", new TextEncoder().encode("msf1\0\0\0\0msf1hevc")),
      ...box("moov", box("trak", box("tkhd", tkhd))),
    ]);
    expect(readImageHeader(sequence, "image/heic-sequence")).toMatchObject({
      width: 1920,
      height: 1080,
      orientation: 1,
    });
  });

  test("a box larger than its file is unreadable", () => {
    const header = heifHeader([ispe(10, 10)]);
    new DataView(header.buffer).setUint32(24, 0x7f_ff_ff_ff);
    expect(readImageHeader(header, "image/heic")).toBeNull();
  });
});

describe("image header dimensions", () => {
  test.each(CASES)(
    "reads $mimeType dimensions from the header alone",
    ({ bytes, expected, mimeType }) => {
      expect(readImageHeader(bytes, mimeType)).toMatchObject({
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

/** `bytes` with a big-endian uint16 written at `offset`. */
const withUint16 = (bytes: Uint8Array, offset: number, value: number) => {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(offset, value);
  return copy;
};

/** `bytes` with a little-endian uint32 written at `offset`. */
const withUint32Le = (bytes: Uint8Array, offset: number, value: number) => {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
};

const MALFORMED = [
  // Truncated headers.
  ["image/png", "truncated", png(10, 10).subarray(0, 20)],
  ["image/jpeg", "truncated", jpeg(10, 10, 6).subarray(0, 60)],
  ["image/gif", "truncated", gif(10, 10).subarray(0, 9)],
  ["image/bmp", "truncated", bmp(10, 10).subarray(0, 24)],
  ["image/webp", "truncated", webpVp8x(10, 10).subarray(0, 29)],
  ["image/tiff", "truncated", tiff().subarray(0, 50)],
  // Undersized segments: a declared length too small for what it must hold.
  [
    "image/png",
    "undersized IHDR",
    (() => {
      const bytes = png(10, 10);
      new DataView(bytes.buffer).setUint32(8, 4);
      return bytes;
    })(),
  ],
  // APP1 of length 4 still followed by the EXIF signature bytes.
  ["image/jpeg", "undersized APP1", withUint16(jpeg(10, 10, 6), 4, 4)],
  ["image/jpeg", "undersized SOF", withUint16(jpeg(10, 10, 1), 59, 4)],
  ["image/bmp", "undersized info header", withUint32Le(bmp(10, 10), 14, 16)],
  [
    "image/webp",
    "undersized VP8X chunk",
    withUint32Le(webpVp8x(10, 10), 16, 2),
  ],
  [
    "image/webp",
    "undersized VP8L chunk",
    withUint32Le(webpLossless(10, 10), 16, 1),
  ],
  // Length fields pointing past the end.
  ["image/jpeg", "APP1 past the end", withUint16(jpeg(10, 10, 6), 4, 0xff_ff)],
  [
    "image/bmp",
    "info header past the end",
    withUint32Le(bmp(10, 10), 14, 0xff_ff),
  ],
  [
    "image/webp",
    "chunk past the end",
    withUint32Le(webpVp8x(10, 10), 16, 0xff_ff),
  ],
  [
    "image/tiff",
    "directory past the end",
    (() => {
      const bytes = tiff();
      new DataView(bytes.buffer).setUint32(4, 0xff_ff);
      return bytes;
    })(),
  ],
] as const satisfies readonly (readonly [
  HeaderReadableImageMimeType,
  string,
  Uint8Array,
])[];

describe("malformed image headers", () => {
  test.each(MALFORMED)(
    "%s with %s reads as unreadable",
    (mimeType, _case, bytes) => {
      expect(readImageHeader(bytes, mimeType)).toBeNull();
    },
  );

  test("an undersized APP1 drops only the orientation, never throws", () => {
    // The frame header after it is intact, so the size is still known.
    const bytes = jpeg(10, 20, 6);
    // Shrink APP1 to 4 bytes and pad the rest with fill bytes so the walk
    // resynchronises at the next marker.
    const shrunk = withUint16(bytes, 4, 4);
    shrunk.fill(0xff, 8, 39);
    expect(readImageHeader(shrunk, "image/jpeg")).toMatchObject({
      width: 10,
      height: 20,
      orientation: 1,
    });
  });

  const MIME_TYPES = [
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
  ] as const satisfies readonly HeaderReadableImageMimeType[];

  test("image header readers never throw on arbitrary bytes", () => {
    assertProperty(
      "image header readers never throw on arbitrary bytes",
      fc.property(
        fc.constantFrom(...MIME_TYPES),
        fc.uint8Array({ maxLength: 96 }),
        (mimeType, bytes) => {
          readImageHeader(bytes, mimeType);
        },
      ),
    );
  });

  test("image header readers never throw on corrupted valid headers", () => {
    assertProperty(
      "image header readers never throw on corrupted valid headers",
      fc.property(
        fc.constantFrom(...CASES),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
          maxLength: 8,
        }),
        fc.nat(),
        ({ bytes, mimeType }, edits, cut) => {
          const corrupted = bytes.slice(0, (cut % bytes.length) + 1);
          for (const [at, value] of edits) {
            corrupted[at % corrupted.length] = value;
          }
          readImageHeader(corrupted, mimeType);
        },
      ),
    );
  });
});
