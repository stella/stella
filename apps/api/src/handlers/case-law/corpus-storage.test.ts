import { describe, expect, test } from "bun:test";

import {
  readCorpusPayloadOrFallback,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import { zstdCompress } from "@/api/lib/compression";
import {
  CorpusPayloadUnavailableError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";

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

/**
 * The read policy has to separate "object storage hiccuped, Postgres still
 * holds the payload" from "the object IS the payload". Only the first may
 * degrade; the second has to fail, or a corpus outage renders as a decision
 * with no body.
 */
describe("readCorpusPayloadOrFallback", () => {
  const unreadable = async (): Promise<string> =>
    await Promise.reject(new Error("bucket unreachable"));

  test("returns the object when the read succeeds", async () => {
    const payload = await readCorpusPayloadOrFallback({
      documentId: "d1",
      key: "corpus/text.zst",
      step: "test",
      read: async () => await Promise.resolve("from object storage"),
      fallback: () => "from postgres",
    });

    expect(payload).toBe("from object storage");
  });

  test("degrades to the Postgres copy when one exists", async () => {
    const payload = await readCorpusPayloadOrFallback({
      documentId: "d1",
      key: "corpus/text.zst",
      step: "test",
      read: unreadable,
      fallback: () => "from postgres",
    });

    expect(payload).toBe("from postgres");
  });

  test("throws when the row has no Postgres copy to degrade to", async () => {
    // bun-types declares `.rejects.toBeInstanceOf` as void, so awaiting it
    // trips type-aware lint; capture the rejection explicitly instead.
    const rejection: unknown = await readCorpusPayloadOrFallback({
      documentId: "d1",
      key: "corpus/text.zst",
      step: "test",
      read: unreadable,
      fallback: () => null,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(CorpusPayloadUnavailableError);
  });

  test("does not pay for the fallback query on the happy path", async () => {
    let fallbacks = 0;

    await readCorpusPayloadOrFallback({
      documentId: "d1",
      key: "corpus/text.zst",
      step: "test",
      read: async () => await Promise.resolve("from object storage"),
      fallback: async () => {
        fallbacks += 1;
        return await Promise.resolve("from postgres");
      },
    });

    expect(fallbacks).toBe(0);
  });

  test("a payload read as empty is not treated as missing", async () => {
    const payload = await readCorpusPayloadOrFallback({
      documentId: "d1",
      key: "corpus/sections.json.zst",
      step: "test",
      read: async () => await Promise.resolve(null),
      fallback: () => null,
    });

    expect(payload).toBeNull();
  });
});
