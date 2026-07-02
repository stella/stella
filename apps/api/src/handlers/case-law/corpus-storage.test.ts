import { describe, expect, test } from "bun:test";

import { readCorpusText } from "@/api/handlers/case-law/corpus-storage";
import { zstdCompress } from "@/api/lib/compression";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

describe("readCorpusText bounded corpus read", () => {
  test("rejects with a TimeoutError when the underlying S3 op never settles", async () => {
    let captured: unknown;
    try {
      // A stalled socket: the read promise never resolves or rejects.
      const neverSettles = new Promise<Uint8Array>(() => {
        // Intentionally never calls resolve/reject.
      });
      await readCorpusText("legal-corpus/never/text.zst", {
        read: async () => await neverSettles,
        timeoutMs: 25,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TimeoutError);
    expect(captured).toMatchObject({ label: "corpus-read-text" });
  });

  test("returns the decompressed text when the read settles in time", async () => {
    const text = await readCorpusText("legal-corpus/ok/text.zst", {
      read: async () => zstdCompress("hello corpus"),
      timeoutMs: 1000,
    });

    expect(text).toBe("hello corpus");
  });
});
