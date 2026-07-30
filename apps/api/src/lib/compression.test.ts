import { describe, expect, test } from "bun:test";

import {
  zstdCompress,
  zstdCompressAsync,
  zstdDecompressToStringBounded,
} from "@/api/lib/compression";

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
    expect(zstdDecompressToStringBounded(compressed, 65_536)).rejects.toThrow(
      /ceiling/u,
    );
  });
});
