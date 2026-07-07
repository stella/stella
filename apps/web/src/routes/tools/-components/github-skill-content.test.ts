import { describe, expect, test } from "bun:test";

import { readCappedBody } from "@/routes/tools/-components/github-skill-content";

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

const encoder = new TextEncoder();

describe("readCappedBody", () => {
  test("decodes a within-cap body", async () => {
    const body = streamOf([encoder.encode("hello "), encoder.encode("world")]);
    expect(await readCappedBody(body, 1024)).toBe("hello world");
  });

  test("returns null once accumulated bytes exceed the cap", async () => {
    const body = streamOf([
      encoder.encode("a".repeat(6)),
      encoder.encode("b".repeat(6)),
    ]);
    // Cap of 8 is blown by the second chunk (12 bytes total).
    expect(await readCappedBody(body, 8)).toBeNull();
  });

  test("does not decode per chunk (multi-byte char split across chunks)", async () => {
    // "é" is 0xC3 0xA9 in UTF-8; split it across two chunks to prove the
    // reader concatenates before decoding rather than corrupting the
    // boundary byte.
    const body = streamOf([new Uint8Array([0xc3]), new Uint8Array([0xa9])]);
    expect(await readCappedBody(body, 1024)).toBe("é");
  });
});
