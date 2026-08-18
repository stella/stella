import { describe, expect, test } from "bun:test";
import { randomFillSync } from "node:crypto";

import {
  PayloadBudgetError,
  zstdCompress,
  zstdCompressAsync,
  zstdCompressBound,
  zstdDecompressToStringBounded,
} from "@/api/lib/compression";

describe("zstdCompressBound", () => {
  test("bounds the frame of incompressible input at every block regime", () => {
    // Random bytes do not compress, so the frame carries the input plus
    // frame and block overhead: larger than the input, never past the bound.
    // Sizes straddle the 128 KiB point where zstd's own margin changes.
    for (const size of [1, 17, 4096, 131_071, 131_072, 262_144, 1_000_003]) {
      const input = new Uint8Array(size);
      randomFillSync(input);
      const frame = zstdCompress(input);
      expect(frame.byteLength).toBeGreaterThan(size);
      expect(frame.byteLength).toBeLessThanOrEqual(zstdCompressBound(size));
    }
    expect(zstdCompress(new Uint8Array()).byteLength).toBeLessThanOrEqual(
      zstdCompressBound(0),
    );
  });

  test("is monotonic and never below its input", () => {
    let previous = zstdCompressBound(0);
    for (let size = 1; size <= 4096; size += 1) {
      const bound = zstdCompressBound(size);
      expect(bound).toBeGreaterThan(size);
      expect(bound).toBeGreaterThanOrEqual(previous);
      previous = bound;
    }
  });
});

describe("bounded corpus compression", () => {
  test("async round-trip preserves the payload", async () => {
    const text = `rozsudek — §  čl. 5 ${"long body ".repeat(1000)}`;
    const compressed = await zstdCompressAsync(text);
    expect(await zstdDecompressToStringBounded(compressed, 1024 * 1024)).toBe(
      text,
    );
  });

  test("sync-compressed objects decompress through the bounded path", async () => {
    // Existing corpus objects were written with the sync variant; the read
    // path must keep accepting them byte-for-byte.
    const compressed = zstdCompress("legacy object");
    expect(await zstdDecompressToStringBounded(compressed, 1024)).toBe(
      "legacy object",
    );
  });

  test("a payload past the decompressed ceiling throws instead of returning", async () => {
    // Highly compressible input: a small object that inflates well past the
    // ceiling — the shape of a corrupt or hostile corpus object.
    const compressed = await zstdCompressAsync("a".repeat(1_000_000));
    const outcome = await zstdDecompressToStringBounded(
      compressed,
      65_536,
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(PayloadBudgetError);
  });
});
