import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { compressRtf } from "@/api/tests/fixtures/tnef";

import {
  COMPRESSED_RTF_PREBUFFER,
  compressedRtfCrc,
  decompressRtf,
} from "./rtf-compressed";

const hex = (text: string) =>
  Uint8Array.from(
    text
      .trim()
      .split(/\s+/u)
      .map((pair) => Number.parseInt(pair, 16)),
  );
const ascii = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const MAX = { maxBytes: 1024 * 1024 };

describe("compressed RTF", () => {
  test("the dictionary starts with the specification's 207 bytes", () => {
    expect(COMPRESSED_RTF_PREBUFFER.byteLength).toBe(207);
    // [MS-OXRTFCP] 3.1.1.3 places the CR LF at 168 and 169.
    expect(ascii(COMPRESSED_RTF_PREBUFFER.subarray(168, 170))).toBe("\r\n");
  });

  // [MS-OXRTFCP] 3.1.1, Example 1: Simple Compressed RTF.
  test("reads the specification's simple example", () => {
    const stream = hex(`
      2d 00 00 00 2b 00 00 00 4c 5a 46 75 f1 c5 c7 a7
      03 00 0a 00 72 63 70 67 31 32 35 42 32 0a f3 20
      68 65 6c 09 00 20 62 77 05 b0 6c 64 7d 0a 80 0f
      a0`);
    expect(compressedRtfCrc(stream.subarray(16))).toBe(0xa7_c7_c5_f1);
    expect(ascii(decompressRtf(stream, MAX).unwrap())).toBe(
      "{\\rtf1\\ansi\\ansicpg1252\\pard hello world}\r\n",
    );
  });

  // [MS-OXRTFCP] 3.1.2, Example 2: a reference that reads bytes it writes.
  test("reads a reference that crosses the write position", () => {
    const stream = hex(`
      1a 00 00 00 1c 00 00 00 4c 5a 46 75 e2 d4 4b 51
      41 00 04 20 57 58 59 5a 0d 6e 7d 01 0e b0`);
    expect(ascii(decompressRtf(stream, MAX).unwrap())).toBe(
      "{\\rtf1 WXYZWXYZWXYZWXYZWXYZ}",
    );
  });

  test("an uncompressed stream is its content", () => {
    const rtf = new TextEncoder().encode("{\\rtf1 Usnesen\\'ed}");
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, rtf.byteLength + 12, true);
    view.setUint32(4, rtf.byteLength, true);
    view.setUint32(8, 0x41_4c_45_4d, true);
    const stream = new Uint8Array(Buffer.concat([header, rtf]));
    expect(ascii(decompressRtf(stream, MAX).unwrap())).toBe(ascii(rtf));
  });

  test("refuses a damaged stream, a stream past its bound and an unknown type", () => {
    const stream = compressRtf(new TextEncoder().encode("{\\rtf1 Rozsudek}"));
    const damaged = stream.slice();
    damaged[20] = ((damaged[20] ?? 0) + 1) % 256;
    expect(decompressRtf(damaged, MAX).isErr()).toBe(true);
    const bounded = decompressRtf(stream, { maxBytes: 4 });
    expect(bounded.isErr() && bounded.error.reason).toBe("limit");
    const unknown = stream.slice();
    unknown[8] = 0x58;
    expect(decompressRtf(unknown, MAX).isErr()).toBe(true);
    expect(decompressRtf(stream.subarray(0, 10), MAX).isErr()).toBe(true);
  });

  test("any RTF reads back from its compressed form", () => {
    assertProperty(
      "any RTF reads back from its compressed form",
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 600 }),
          fc
            .array(
              fc.constantFrom(
                "{\\rtf1",
                "\\par ",
                "\\pard",
                "Klageerwiderung ",
                "\\'fc",
                "}",
                " ",
              ),
              { maxLength: 80 },
            )
            .map((parts) => new TextEncoder().encode(parts.join(""))),
        ),
        (rtf) => {
          expect(
            Array.from(decompressRtf(compressRtf(rtf), MAX).unwrap()),
          ).toEqual(Array.from(rtf));
        },
      ),
      { numRuns: 60 },
    );
  });

  test("any bytes read as RTF or are refused, never more than the bound", () => {
    assertProperty(
      "any bytes read as RTF or are refused, never more than the bound",
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 200 }), (bytes) => {
        const read = decompressRtf(bytes, { maxBytes: 64 });
        if (read.isOk()) {
          expect(read.value.byteLength).toBeLessThanOrEqual(64);
        }
      }),
    );
  });
});
