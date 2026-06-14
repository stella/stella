import { describe, expect, test } from "bun:test";

import { createZipBombGuard } from "@/api/lib/file-scan/scanner";

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >> 8) & 0xff,
  (n >> 16) & 0xff,
  (n >> 24) & 0xff,
];

// A raw ZIP local file header with sizes written into the header itself.
// (JSZip zeros these and uses a trailing data descriptor, which the guard
// deliberately cannot read — so headers are hand-built here.)
const localFileHeader = ({
  flags = 0,
  compressedSize,
  uncompressedSize,
  fileName = "f",
}: {
  flags?: number;
  compressedSize: number;
  uncompressedSize: number;
  fileName?: string;
}): number[] => {
  const name = [...new TextEncoder().encode(fileName)];
  const data = new Array<number>(compressedSize).fill(0);
  return [
    0x50,
    0x4b,
    0x03,
    0x04, // PK\x03\x04
    ...u16(20), // version needed
    ...u16(flags),
    ...u16(8), // method: deflate
    ...u16(0), // mod time
    ...u16(0), // mod date
    ...u32(0), // crc32
    ...u32(compressedSize),
    ...u32(uncompressedSize),
    ...u16(name.length),
    ...u16(0), // extra length
    ...name,
    ...data,
  ];
};

const zip = (...entries: number[][]): Uint8Array =>
  new Uint8Array(entries.flat());

const guard = createZipBombGuard({
  maxEntries: 3,
  maxTotalUncompressedBytes: 1000,
  maxCompressionRatio: 100,
});

describe("createZipBombGuard", () => {
  test("ignores non-ZIP and tiny inputs", async () => {
    expect(await guard.scan(new Uint8Array([1, 2, 3, 4, 5]))).toEqual([]);
    expect(await guard.scan(new Uint8Array([1, 2]))).toEqual([]);
  });

  test("passes a benign archive within all limits", async () => {
    const bytes = zip(
      localFileHeader({ compressedSize: 8, uncompressedSize: 16 }),
    );
    expect(await guard.scan(bytes)).toEqual([]);
  });

  test("flags an extreme compression ratio", async () => {
    const bytes = zip(
      localFileHeader({ compressedSize: 4, uncompressedSize: 4000 }),
    );
    const matches = await guard.scan(bytes);
    expect(matches[0]?.rule).toBe("zip-bomb-ratio");
    expect(matches[0]?.severity).toBe("critical");
  });

  test("flags too many entries", async () => {
    const small = () =>
      localFileHeader({ compressedSize: 2, uncompressedSize: 2 });
    const matches = await guard.scan(zip(small(), small(), small(), small()));
    expect(matches[0]?.rule).toBe("zip-bomb-entries");
  });

  test("flags total uncompressed size over the cap", async () => {
    const lenient = createZipBombGuard({
      maxEntries: 10,
      maxTotalUncompressedBytes: 1000,
      maxCompressionRatio: 100_000,
    });
    const bytes = zip(
      localFileHeader({ compressedSize: 50, uncompressedSize: 2000 }),
    );
    const matches = await lenient.scan(bytes);
    expect(matches[0]?.rule).toBe("zip-bomb-size");
  });

  test("flags a data-descriptor entry whose header sizes are zero", async () => {
    const bytes = zip(
      localFileHeader({
        flags: 0x08,
        compressedSize: 0,
        uncompressedSize: 0,
      }),
    );
    const matches = await guard.scan(bytes);
    expect(matches[0]?.rule).toBe("zip-data-descriptor");
    expect(matches[0]?.severity).toBe("suspicious");
  });
});
