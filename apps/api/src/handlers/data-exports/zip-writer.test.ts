import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  centralDirectoryHeader,
  dataDescriptor,
  endOfArchive,
  FLAG_DATA_DESCRIPTOR,
  FLAG_UTF8,
  UINT16_MAX,
  UINT32_MAX,
  writeZip,
  ZIP_COMPRESSION,
  ZipStreamLengthError,
} from "@/api/handlers/data-exports/zip-writer";
import type {
  WrittenZipEntry,
  ZipEntryInput,
} from "@/api/handlers/data-exports/zip-writer";

const MODIFIED_AT = new Date("2026-03-04T05:06:08.000Z");

const collect = async (
  entries: readonly ZipEntryInput[],
  onEntry?: (entry: WrittenZipEntry) => void,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of writeZip(entries, onEntry ? { onEntry } : {})) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

// Bit 11 of a general-purpose flag field, read without bitwise operators.
const hasUtf8Flag = (flags: number): boolean =>
  Math.floor(flags / FLAG_UTF8) % 2 === 1;

// Locate one central directory header by its file name.
const findCentralHeader = (
  archive: Uint8Array,
  name: string,
): { flags: number; method: number; extraLength: number; offset: number } => {
  const target = text(name);
  const data = view(archive);
  for (let offset = 0; offset < archive.byteLength - 46; offset++) {
    if (data.getUint32(offset, true) !== 0x02_01_4b_50) {
      continue;
    }
    const nameLength = data.getUint16(offset + 28, true);
    const candidate = archive.subarray(offset + 46, offset + 46 + nameLength);
    if (Buffer.from(candidate).equals(Buffer.from(target))) {
      return {
        flags: data.getUint16(offset + 8, true),
        method: data.getUint16(offset + 10, true),
        extraLength: data.getUint16(offset + 30, true),
        offset,
      };
    }
  }
  throw new Error(`No central header for ${name}`);
};

describe("export ZIP writer", () => {
  test("round-trips stored and deflated entries byte for byte", async () => {
    const pdf = new Uint8Array(4096).map((_, i) => (i * 31) % 251);
    const json = text(
      JSON.stringify({ rows: Array.from({ length: 200 }, () => "repeat") }),
    );
    const archive = await collect([
      {
        name: "matters/a/doc.pdf",
        modifiedAt: MODIFIED_AT,
        source: {
          type: "bytes" as const,
          data: pdf,
          compression: ZIP_COMPRESSION.STORE,
        },
      },
      {
        name: "manifest.json",
        modifiedAt: MODIFIED_AT,
        source: {
          type: "bytes" as const,
          data: json,
          compression: ZIP_COMPRESSION.DEFLATE,
        },
      },
    ]);

    const zip = await JSZip.loadAsync(archive);
    expect(await zip.file("matters/a/doc.pdf")?.async("uint8array")).toEqual(
      pdf,
    );
    expect(await zip.file("manifest.json")?.async("uint8array")).toEqual(json);
    expect(findCentralHeader(archive, "matters/a/doc.pdf").method).toBe(0);
    expect(findCentralHeader(archive, "manifest.json").method).toBe(8);
  });

  test("keeps an entry stored when deflate would not shrink it", async () => {
    const random = crypto.getRandomValues(new Uint8Array(2048));
    const written: WrittenZipEntry[] = [];
    const archive = await collect(
      [
        {
          name: "noise.bin",
          modifiedAt: MODIFIED_AT,
          source: {
            type: "bytes" as const,
            data: random,
            compression: ZIP_COMPRESSION.DEFLATE,
          },
        },
      ],
      (entry) => {
        written.push(entry);
      },
    );
    expect(written).toEqual([
      {
        name: "noise.bin",
        compression: ZIP_COMPRESSION.STORE,
        compressedSize: random.byteLength,
        uncompressedSize: random.byteLength,
      },
    ]);
    const zip = await JSZip.loadAsync(archive);
    expect(await zip.file("noise.bin")?.async("uint8array")).toEqual(random);
  });

  test("sets the UTF-8 flag and writes names as UTF-8", async () => {
    const name = "matters/Smlouva o dílo/Příloha č. 1 – 契約.docx";
    const archive = await collect([
      {
        name,
        modifiedAt: MODIFIED_AT,
        source: {
          type: "bytes",
          data: text("x"),
          compression: ZIP_COMPRESSION.STORE,
        },
      },
    ]);
    const header = findCentralHeader(archive, name);
    expect(hasUtf8Flag(header.flags)).toBe(true);
    const local = view(archive);
    expect(hasUtf8Flag(local.getUint16(6, true))).toBe(true);
    const zip = await JSZip.loadAsync(archive);
    expect(Object.keys(zip.files)).toEqual([name]);
  });

  test("refuses duplicate entry names", async () => {
    const entry = {
      name: "a.txt",
      modifiedAt: MODIFIED_AT,
      source: {
        type: "bytes" as const,
        data: text("a"),
        compression: ZIP_COMPRESSION.STORE,
      },
    };
    const rejection = await rejectionOf(collect([entry, entry]));
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      message: "Duplicate ZIP entry name: a.txt",
    });
  });

  test.each([
    { first: "ß.pdf", second: "ẞ.pdf" },
    { first: "Σ.pdf", second: "ς.pdf" },
    { first: "Smlouva č. 1.pdf", second: "Smlouva c\u030c. 1.pdf" },
    { first: "Ž.docx", second: "ž.docx" },
  ])(
    "refuses filesystem-equivalent entry names: $first and $second",
    async ({ first, second }) => {
      const entries = [first, second].map((name) => ({
        name,
        modifiedAt: MODIFIED_AT,
        source: {
          type: "bytes" as const,
          data: text("document"),
          compression: ZIP_COMPRESSION.STORE,
        },
      }));
      const rejection = await rejectionOf(collect(entries));
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).toMatchObject({
        message: `Duplicate ZIP entry name: ${second}`,
      });
    },
  );

  test("writes no ZIP64 records for a small archive", async () => {
    const archive = await collect([
      {
        name: "a.txt",
        modifiedAt: MODIFIED_AT,
        source: {
          type: "bytes" as const,
          data: text("a"),
          compression: ZIP_COMPRESSION.STORE,
        },
      },
    ]);
    const data = view(archive);
    for (let offset = 0; offset < archive.byteLength - 4; offset++) {
      expect(data.getUint32(offset, true)).not.toBe(0x06_06_4b_50);
    }
    // 9-byte extended timestamp only, no ZIP64 extra.
    expect(findCentralHeader(archive, "a.txt").extraLength).toBe(9);
  });

  test("switches to ZIP64 end records at 65535 entries", async () => {
    const entries = Array.from({ length: UINT16_MAX }, (_, i) => ({
      name: `f/${i}`,
      modifiedAt: MODIFIED_AT,
      source: {
        type: "bytes" as const,
        data: new Uint8Array(0),
        compression: ZIP_COMPRESSION.STORE,
      },
    }));
    const archive = await collect(entries);
    const data = view(archive);
    const eocd = archive.byteLength - 22;
    expect(data.getUint32(eocd, true)).toBe(0x06_05_4b_50);
    expect(data.getUint16(eocd + 8, true)).toBe(UINT16_MAX);
    const locator = eocd - 20;
    expect(data.getUint32(locator, true)).toBe(0x07_06_4b_50);
    const zip64Offset = Number(data.getBigUint64(locator + 8, true));
    expect(data.getUint32(zip64Offset, true)).toBe(0x06_06_4b_50);
    expect(Number(data.getBigUint64(zip64Offset + 32, true))).toBe(UINT16_MAX);

    const zip = await JSZip.loadAsync(archive);
    expect(Object.keys(zip.files)).toHaveLength(UINT16_MAX);
  });

  test("stays on classic end records one entry below the ZIP64 boundary", () => {
    const records = endOfArchive({
      entryCount: UINT16_MAX - 1,
      centralDirectoryOffset: UINT32_MAX - 1,
      centralDirectorySize: 100,
    });
    expect(records.byteLength).toBe(22);
  });

  test("moves offsets past 4 GiB into the central ZIP64 extra field", () => {
    const offset = UINT32_MAX + 10;
    const header = centralDirectoryHeader({
      nameBytes: text("big.pdf"),
      flags: FLAG_UTF8,
      method: 0,
      crc32: 0,
      compressedSize: 5,
      uncompressedSize: 5,
      dos: { time: 0, date: 0 },
      timestampExtra: new Uint8Array(0),
      localHeaderOffset: offset,
    });
    const data = view(header);
    expect(data.getUint32(42, true)).toBe(UINT32_MAX);
    expect(data.getUint16(6, true)).toBe(45);
    const extraStart = 46 + "big.pdf".length;
    expect(data.getUint16(extraStart, true)).toBe(0x00_01);
    // Sizes fit, so the extra carries the offset alone.
    expect(data.getUint16(extraStart + 2, true)).toBe(8);
    expect(Number(data.getBigUint64(extraStart + 4, true))).toBe(offset);
  });

  test("writes ZIP64 end records when the central directory starts past 4 GiB", () => {
    const records = endOfArchive({
      entryCount: 3,
      centralDirectoryOffset: UINT32_MAX,
      centralDirectorySize: 200,
    });
    const data = view(records);
    expect(data.getUint32(0, true)).toBe(0x06_06_4b_50);
    expect(Number(data.getBigUint64(48, true))).toBe(UINT32_MAX);
    const eocd = records.byteLength - 22;
    expect(data.getUint32(eocd + 16, true)).toBe(UINT32_MAX);
    expect(data.getUint16(eocd + 8, true)).toBe(3);
  });

  test("streams large entries through with a data descriptor and a valid CRC", async () => {
    const chunks = [
      text("first chunk, "),
      text("second chunk, "),
      text("last"),
    ];
    const whole = Buffer.concat(chunks);
    const stream = async function* () {
      yield* chunks;
    };
    const archive = await collect([
      {
        name: "matters/a/large.pdf",
        modifiedAt: MODIFIED_AT,
        source: {
          type: "stream",
          chunks: stream(),
          sizeBytes: whole.byteLength,
        },
      },
      {
        name: "manifest.json",
        modifiedAt: MODIFIED_AT,
        source: {
          type: "bytes",
          data: text("{}"),
          compression: ZIP_COMPRESSION.DEFLATE,
        },
      },
    ]);
    const header = findCentralHeader(archive, "matters/a/large.pdf");
    expect(header.method).toBe(0);
    expect(Math.floor(header.flags / FLAG_DATA_DESCRIPTOR) % 2).toBe(1);
    const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
    expect(await zip.file("matters/a/large.pdf")?.async("uint8array")).toEqual(
      new Uint8Array(whole),
    );
    expect(await zip.file("manifest.json")?.async("string")).toBe("{}");
  });

  test("refuses a stream that ends at another length than announced", async () => {
    const stream = async function* () {
      yield text("short");
    };
    const rejection = await rejectionOf(
      collect([
        {
          name: "a.bin",
          modifiedAt: MODIFIED_AT,
          source: { type: "stream", chunks: stream(), sizeBytes: 999 },
        },
      ]),
    );
    expect(rejection).toBeInstanceOf(ZipStreamLengthError);
  });

  test("widens the data descriptor sizes to 64 bits past 4 GiB", () => {
    const narrow = dataDescriptor({ crc32: 1, sizeBytes: 10, zip64: false });
    const wide = dataDescriptor({
      crc32: 1,
      sizeBytes: UINT32_MAX + 1,
      zip64: true,
    });
    expect(narrow.byteLength).toBe(16);
    expect(wide.byteLength).toBe(24);
    expect(Number(view(wide).getBigUint64(8, true))).toBe(UINT32_MAX + 1);
  });
});
