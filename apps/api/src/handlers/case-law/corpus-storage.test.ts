import { describe, expect, test } from "bun:test";

import {
  corpusContentHash,
  EMPTY_CORPUS_CONTENT_HASHES,
  readCorpusPayloadOrFallback,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
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

describe("empty corpus payload hashes", () => {
  /**
   * These identify the objects a metadata-first ingest writes before the
   * document exists, and an operator counts and repairs rows by them
   * (`backfill-corpus-storage.ts --include-stale-empty`). Pinning the
   * values means a change to the hash function or to the empty shapes
   * shows up as a failing test rather than as a repair run that silently
   * matches nothing.
   */
  test("cover the empty shapes a metadata-first ingest writes", () => {
    // The two shapes the pipeline itself writes stay pinned by value; the
    // matrix additionally covers legacy column shapes the backfill copies
    // verbatim (stored `[]` sections, a valid AST with no blocks).
    expect(EMPTY_CORPUS_CONTENT_HASHES).toContain(
      "38c18e8567ab7eb43737fbcb0b460cc715edc003359f072526757949857ba315",
    );
    expect(EMPTY_CORPUS_CONTENT_HASHES).toContain(
      "c21295bcba9c492b8fa6894ee2fcd6ca93b825ea61fc4965d00f41ea611071e2",
    );
    expect(EMPTY_CORPUS_CONTENT_HASHES).toHaveLength(4);
    expect(new Set(EMPTY_CORPUS_CONTENT_HASHES).size).toBe(4);
    expect(EMPTY_CORPUS_CONTENT_HASHES).toContain(
      corpusContentHash({ text: "", sections: [], ast: null }),
    );
  });

  test("a payload carrying a document hashes to none of them", () => {
    const real = corpusContentHash({
      text: "Rozsudok",
      sections: null,
      ast: EMPTY_AST,
    });

    expect([...EMPTY_CORPUS_CONTENT_HASHES]).not.toContain(real);
  });

  test("an empty text and a null text are the same payload", () => {
    expect(
      corpusContentHash({ text: "", sections: null, ast: EMPTY_AST }),
    ).toBe(corpusContentHash({ text: null, sections: null, ast: EMPTY_AST }));
  });

  test("a stored document keeps the hash it was written with", () => {
    // Every corpus key and every indexedHash comparison in the corpus
    // derives from this value, so the hash of a known payload is part of
    // the storage format, not an implementation detail.
    expect(
      corpusContentHash({
        text: "Rozsudok",
        sections: [{ index: 0, type: "header", title: null, text: "Rozsudok" }],
        ast: EMPTY_AST,
      }),
    ).toBe("9d69e9cdfe9a15179939cc74ac6af324d03b6dc049bf4fe010971b56767bab2b");
  });
});
