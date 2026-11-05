import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { createLineReader } from "./json-lines";

const encoder = new TextEncoder();

const read = (chunks: readonly Uint8Array[], maxLineBytes: number) => {
  const lines: string[] = [];
  const state = { oversized: false };
  const reader = createLineReader({
    maxLineBytes,
    line: (line) => {
      lines.push(line);
    },
    oversized: () => {
      state.oversized = true;
    },
  });
  for (const chunk of chunks) {
    reader.push(chunk);
  }
  reader.end();
  return { lines, oversized: state.oversized };
};

/** `bytes` cut at the given offsets. */
const cut = (bytes: Uint8Array, offsets: readonly number[]) => {
  const points = [...new Set(offsets)]
    .filter((offset) => offset > 0 && offset < bytes.length)
    .toSorted((a, b) => a - b);
  return [0, ...points].map((start, index) =>
    bytes.subarray(start, points[index] ?? bytes.length),
  );
};

describe("newline framing", () => {
  test("every chunking of the same bytes yields the same lines", () => {
    assertProperty(
      "every chunking of the same bytes yields the same lines",
      fc.property(
        fc.array(
          fc
            .string({ unit: "grapheme" })
            .map((text) => text.replaceAll("\n", "")),
          { maxLength: 6 },
        ),
        fc.array(fc.nat({ max: 200 }), { maxLength: 12 }),
        (lines, offsets) => {
          const bytes = encoder.encode(
            lines.map((line) => `${line}\n`).join(""),
          );
          expect(read(cut(bytes, offsets), 1024)).toEqual({
            lines,
            oversized: false,
          });
        },
      ),
    );
  });

  test("a complete line over the limit is refused even when its newline arrives in the overflowing chunk", () => {
    const { lines, oversized } = read(
      [encoder.encode("ok\n12345"), encoder.encode("6\nnext\n")],
      5,
    );
    expect(lines).toEqual(["ok"]);
    expect(oversized).toBe(true);
  });

  test("the limit counts bytes, not characters", () => {
    // Three characters, six bytes.
    expect(read([encoder.encode("ččč\n")], 5)).toEqual({
      lines: [],
      oversized: true,
    });
    expect(read([encoder.encode("ččč\n")], 6)).toEqual({
      lines: ["ččč"],
      oversized: false,
    });
  });

  test("an unterminated line over the limit is refused before its newline arrives", () => {
    expect(read([encoder.encode("123456")], 5)).toEqual({
      lines: [],
      oversized: true,
    });
  });

  test("a last line without a newline is still delivered", () => {
    expect(read([encoder.encode("a\nb")], 5)).toEqual({
      lines: ["a", "b"],
      oversized: false,
    });
  });
});
