import { describe, expect, test } from "bun:test";

import { createZipBombGuard } from "@/api/lib/file-scan/scanner";

const BYTE_MODULUS = 256;
const byteAt = (n: number, byteIndex: number): number =>
  Math.trunc(n / BYTE_MODULUS ** byteIndex) % BYTE_MODULUS;

const u16 = (n: number): number[] => [byteAt(n, 0), byteAt(n, 1)];
const u32 = (n: number): number[] => [
  byteAt(n, 0),
  byteAt(n, 1),
  byteAt(n, 2),
  byteAt(n, 3),
];

type EntrySpec = {
  flags?: number;
  compressedSize: number;
  uncompressedSize: number;
  fileName?: string;
  /**
   * Sizes written into the local header, when they differ from the real
   * ones. A writer that streams an entry leaves them zero and repeats them
   * in a trailing data descriptor.
   */
  headerSizes?: { compressedSize: number; uncompressedSize: number };
};

const encode = (text: string): number[] => [...new TextEncoder().encode(text)];

// A raw ZIP local file header, hand-built so entry sizes can be set
// independently of the file data.
const localFileHeader = ({
  flags = 0,
  compressedSize,
  uncompressedSize,
  fileName = "f",
  headerSizes,
}: EntrySpec): number[] => {
  const name = encode(fileName);
  const data = Array.from({ length: compressedSize }, () => 0);
  const sizes = headerSizes ?? { compressedSize, uncompressedSize };
  return [
    80,
    75,
    3,
    4, // PK\x03\x04
    ...u16(20), // version needed
    ...u16(flags),
    ...u16(8), // method: deflate
    ...u16(0), // mod time
    ...u16(0), // mod date
    ...u32(0), // crc32
    ...u32(sizes.compressedSize),
    ...u32(sizes.uncompressedSize),
    ...u16(name.length),
    ...u16(0), // extra length
    ...name,
    ...data,
  ];
};

const centralFileHeader = (
  { flags = 0, compressedSize, uncompressedSize, fileName = "f" }: EntrySpec,
  localOffset: number,
): number[] => {
  const name = encode(fileName);
  return [
    80,
    75,
    1,
    2, // PK\x01\x02
    ...u16(20), // version made by
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
    ...u16(0), // comment length
    ...u16(0), // disk number
    ...u16(0), // internal attributes
    ...u32(0), // external attributes
    ...u32(localOffset),
    ...name,
  ];
};

/** Concatenated local headers with no central directory. */
const zip = (...entries: number[][]): Uint8Array =>
  new Uint8Array(entries.flat());

/** A complete archive: local headers, central directory, EOCD record. */
const archive = (...entries: EntrySpec[]): Uint8Array => {
  const local: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    central.push(...centralFileHeader(entry, local.length));
    local.push(...localFileHeader(entry));
  }
  const eocd = [
    80,
    75,
    5,
    6, // PK\x05\x06
    ...u16(0), // disk number
    ...u16(0), // disk with central directory
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0), // comment length
  ];
  return new Uint8Array([...local, ...central, ...eocd]);
};

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

  test("rejects an archive whose sizes cannot be read anywhere", async () => {
    const bytes = zip(
      localFileHeader({
        flags: 8,
        compressedSize: 0,
        uncompressedSize: 0,
      }),
    );
    const matches = await guard.scan(bytes);
    expect(matches[0]?.rule).toBe("zip-unverifiable");
    expect(matches[0]?.severity).toBe("malicious");
  });

  test("reads sizes from the central directory", async () => {
    const bytes = archive({
      fileName: "a",
      compressedSize: 4,
      uncompressedSize: 4000,
    });
    const matches = await guard.scan(bytes);
    expect(matches[0]?.rule).toBe("zip-bomb-ratio");
  });

  test("checks every entry past a streamed one", async () => {
    const bytes = archive(
      {
        fileName: "streamed",
        flags: 8,
        compressedSize: 8,
        uncompressedSize: 16,
        headerSizes: { compressedSize: 0, uncompressedSize: 0 },
      },
      { fileName: "b", compressedSize: 4, uncompressedSize: 4000 },
    );
    const matches = await guard.scan(bytes);
    expect(matches[0]?.rule).toBe("zip-bomb-ratio");
    expect(matches[0]?.severity).toBe("critical");
  });

  test("sums uncompressed sizes across every central directory entry", async () => {
    const lenient = createZipBombGuard({
      maxEntries: 10,
      maxTotalUncompressedBytes: 1000,
      maxCompressionRatio: 100_000,
    });
    const entry = (fileName: string) => ({
      fileName,
      flags: 8,
      compressedSize: 40,
      uncompressedSize: 400,
      headerSizes: { compressedSize: 0, uncompressedSize: 0 },
    });
    const matches = await lenient.scan(
      archive(entry("a"), entry("b"), entry("c")),
    );
    expect(matches[0]?.rule).toBe("zip-bomb-size");
  });

  test("passes a complete archive within all limits", async () => {
    const bytes = archive({
      fileName: "a",
      compressedSize: 8,
      uncompressedSize: 16,
    });
    expect(await guard.scan(bytes)).toEqual([]);
  });
});
