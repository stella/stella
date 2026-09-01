import { describe, expect, test } from "bun:test";
import { randomFillSync } from "node:crypto";

import { CASE_LAW_CORPUS_MIRROR_STATUS } from "@/api/db/schema";
import {
  PayloadBudgetError,
  zstdCompress,
  zstdCompressBound,
} from "@/api/lib/compression";
import { CORPUS_STORAGE_MODES } from "@/api/lib/corpus-storage-mode";
import {
  CorpusPayloadUnavailableError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import {
  formatCorpusLocation,
  parseCorpusLocation,
} from "@/api/lib/legal-search/corpus-location";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  corpusContentHash,
  corpusKeys,
  corpusMirrorColumns,
  corpusPayloadDisposition,
  CORPUS_TRANSFER_MAX_BYTES,
  deleteCorpusDocument,
  EMPTY_CORPUS_CONTENT_HASHES,
  parsePersistedCorpusAst,
  parsePersistedCorpusSections,
  planCorpusDocumentWrite,
  readCorpusAtAuthoritativePointer,
  readCorpusBytesAt,
  readCorpusPayloadOrFallback,
  readCorpusText,
  storedCorpusWrite,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  CorpusPayload,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import { MissingCorpusObjectError } from "@/api/lib/s3";

describe("corpus mirror state columns", () => {
  test("partition pending and settled pointer states", () => {
    expect(
      corpusMirrorColumns({
        status: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      }),
    ).toEqual({
      corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
      contentHash: null,
    });
    expect(
      corpusMirrorColumns({
        status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        written: {
          textKey: "corpus/text.zst",
          sectionsKey: "corpus/sections.zst",
          astKey: "corpus/ast.zst",
          contentHash: "content-hash",
        },
      }),
    ).toEqual({
      corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
      textS3Key: "corpus/text.zst",
      normalizedS3Key: "corpus/sections.zst",
      astS3Key: "corpus/ast.zst",
      contentHash: "content-hash",
    });
  });
});

/**
 * Canonical storage serves reads from object storage, so a write path that
 * keeps persisting the Postgres payload columns leaves rows in a shape the
 * deployed mode does not describe and makes any external cleanup pass chase
 * the writers. The disposition is the single place that answers whether a
 * settling write may drop them, so it is asserted over the whole mode set
 * rather than over the modes that happen to be interesting.
 */
describe("corpusPayloadDisposition", () => {
  const written = {
    textKey: "corpus/text.zst",
    sectionsKey: "corpus/sections.zst",
    astKey: "corpus/ast.zst",
    contentHash: "content-hash",
  } as const satisfies WriteCorpusResult;

  test("only canonical storage drops the columns, and only once written", () => {
    const dispositions = Object.fromEntries(
      CORPUS_STORAGE_MODES.map((mode) => [
        mode,
        {
          confirmed: corpusPayloadDisposition({ mode, written }),
          unwritten: corpusPayloadDisposition({ mode, written: null }),
        },
      ]),
    );

    expect(dispositions).toEqual({
      off: { confirmed: "retain", unwritten: "retain" },
      "dual-write": { confirmed: "retain", unwritten: "retain" },
      canonical: { confirmed: "trim", unwritten: "retain" },
    });
  });

  test("every storage mode is decided", () => {
    // A new mode must not inherit "retain" by omission: the switch is
    // exhaustive, and this pins the set the assertion above covers.
    expect(new Set(CORPUS_STORAGE_MODES)).toEqual(
      new Set(["off", "dual-write", "canonical"]),
    );
  });

  test("the trimmed shape nulls exactly the three payload columns", () => {
    expect(TRIMMED_CORPUS_PAYLOAD_COLUMNS).toEqual({
      fulltext: null,
      sections: null,
      documentAst: null,
    });
  });
});

describe("readCorpusText bounded corpus read", () => {
  test("rejects with a TimeoutError when the underlying S3 op never settles", async () => {
    let captured: unknown;
    try {
      // A stalled socket: the read promise never resolves or rejects.
      const neverSettles = new Promise<Uint8Array>(() => {
        // Intentionally never calls resolve/reject.
      });
      await readCorpusText("legal-corpus/never/text.zst", {
        readObject: async () => await neverSettles,
        timeoutMs: 25,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TimeoutError);
    expect(captured).toMatchObject({ label: "corpus-read-text" });
  });

  test("returns the decompressed text when the read settles in time", async () => {
    const seen: { key: string; maxBytes: number }[] = [];
    const text = await readCorpusText("legal-corpus/ok/text.zst", {
      readObject: async ({ key, maxBytes }) => {
        seen.push({ key, maxBytes });
        return await Promise.resolve(zstdCompress("hello corpus"));
      },
      timeoutMs: 1000,
    });

    expect(text).toBe("hello corpus");
    expect(seen).toEqual([
      { key: "legal-corpus/ok/text.zst", maxBytes: CORPUS_TRANSFER_MAX_BYTES },
    ]);
  });

  test("the transfer ceiling admits a frame at zstd's bound over the decompressed ceiling", () => {
    // Incompressible input yields a frame larger than the input; the
    // transfer ceiling must therefore sit above the decompressed one by at
    // least that overhead, or a valid payload at the decompressed ceiling
    // could be refused before decoding.
    const random = new Uint8Array(4096);
    randomFillSync(random);
    const frame = zstdCompress(random);
    expect(frame.byteLength).toBeGreaterThan(random.byteLength);
    expect(frame.byteLength).toBeLessThanOrEqual(
      zstdCompressBound(random.byteLength),
    );
    expect(CORPUS_TRANSFER_MAX_BYTES).toBe(
      zstdCompressBound(LIMITS.corpusPayloadMaxDecompressedBytes),
    );
    expect(CORPUS_TRANSFER_MAX_BYTES).toBeGreaterThan(
      LIMITS.corpusPayloadMaxDecompressedBytes,
    );
  });
});

describe("authoritative corpus pointer reread", () => {
  const missing = (key: string) =>
    new MissingCorpusObjectError({
      message: `Corpus object is absent: ${key}`,
      key,
    });

  test("retries one changed pointer after a confirmed absence", async () => {
    const oldKey = `pack:legal-corpus/packs/old.pack#offset=10&length=20&sha256=${"a".repeat(64)}`;
    const replacementKey = `pack:legal-corpus/packs/new.pack#offset=30&length=20&sha256=${"b".repeat(64)}`;
    const reads: string[] = [];
    const value = await readCorpusAtAuthoritativePointer({
      storedKey: oldKey,
      read: async (key) => {
        reads.push(key);
        if (key === oldKey) {
          throw missing(key);
        }
        return "payload";
      },
      rereadStoredKey: async () => await Promise.resolve(replacementKey),
    });

    expect(value).toBe("payload");
    expect(reads).toEqual([oldKey, replacementKey]);
  });

  test("preserves the first absence when authority is unchanged", async () => {
    const first = missing("legal-corpus/current.zst");
    let rereads = 0;
    const rejection: unknown = await readCorpusAtAuthoritativePointer({
      storedKey: first.key,
      read: async () => await Promise.reject(first),
      rereadStoredKey: async () => {
        rereads += 1;
        return first.key;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(first);
    expect(rereads).toBe(1);
  });

  test("does not reread authority for another storage failure", async () => {
    const failure = new Error("authorization failed");
    let rereads = 0;
    const rejection: unknown = await readCorpusAtAuthoritativePointer({
      storedKey: "legal-corpus/current.zst",
      read: async () => await Promise.reject(failure),
      rereadStoredKey: async () => {
        rereads += 1;
        return "legal-corpus/replacement.zst";
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(failure);
    expect(rereads).toBe(0);
  });
});

describe("persisted corpus JSON validation", () => {
  test("preserves compatibility with additive section fields", () => {
    expect(
      parsePersistedCorpusSections([
        {
          index: 0,
          type: "header",
          title: null,
          text: "Rozsudok",
          upstreamAddition: true,
        },
      ]),
    ).toEqual([{ index: 0, type: "header", title: null, text: "Rozsudok" }]);
  });

  test("rejects malformed section and AST claims", () => {
    expect(() =>
      parsePersistedCorpusSections([
        { index: "0", type: "header", title: null, text: "Rozsudok" },
      ]),
    ).toThrow('Invalid type: Expected number but received "0"');
    expect(() =>
      parsePersistedCorpusAst({ version: 1, blocks: [{ type: "paragraph" }] }),
    ).toThrow("Invalid type: Expected (Object | unknown) but received Object");
    expect(() => parsePersistedCorpusAst([])).toThrow(
      "Invalid type: Expected (Object | unknown) but received Array",
    );
    expect(() => parsePersistedCorpusAst({ unexpected: true })).toThrow(
      "Invalid type: Expected (Object | unknown) but received Object",
    );
  });

  test("serves a stored AST whose block role this reader does not declare", () => {
    const parsed = parsePersistedCorpusAst({
      version: 1,
      blocks: [
        {
          id: "p1",
          anchorId: "p-1",
          type: "paragraph",
          role: "declared-by-a-newer-parser",
          inlines: [{ type: "text", text: "Rozsudok" }],
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.blocks.at(0)?.role).toBe("unknown");
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

describe("planCorpusDocumentWrite", () => {
  const documentId = "0d2f4a5e-9c1b-4c62-8b1a-3f6f2f8f9e10";
  const jurisdiction = "SVK";
  const documentPayload: CorpusPayload = {
    text: "Rozsudok v mene Slovenskej republiky. Súd rozhodol o veci samej.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "Rozsudok v mene Slovenskej republiky.",
      },
    ],
    ast: EMPTY_AST,
  };
  /** The write the settle path would record for `documentPayload`. */
  const recordedWrite = (id: string, partition: string) => {
    const contentHash = corpusContentHash(documentPayload);
    return {
      ...corpusKeys({ documentId: id, jurisdiction: partition, contentHash }),
      contentHash,
    };
  };

  test("refuses every payload shape that carries no document", () => {
    const texts = [null, ""];
    const sectionShapes = [null, []];
    const astShapes = [EMPTY_AST, null];
    for (const text of texts) {
      for (const sections of sectionShapes) {
        for (const ast of astShapes) {
          expect(
            planCorpusDocumentWrite({
              documentId,
              jurisdiction,
              text,
              sections,
              ast,
              stored: null,
            }),
          ).toEqual({
            type: "skipped-empty",
            written: null,
            contentHash: corpusContentHash({ text, sections, ast }),
          });
        }
      }
    }
  });

  test("refuses re-writing the exact write the row records", () => {
    const stored = recordedWrite(documentId, jurisdiction);
    expect(
      planCorpusDocumentWrite({
        documentId,
        jurisdiction,
        ...documentPayload,
        stored,
      }),
    ).toEqual({ type: "skipped-unchanged", written: stored });
  });

  test("writes when the payload differs from the recorded write", () => {
    const stored = recordedWrite(documentId, jurisdiction);
    const changed = {
      ...documentPayload,
      text: `${documentPayload.text} Opravené znenie.`,
    };
    // The fixture must express the fault: an unchanged hash would make the
    // equality guard the thing under test trivially pass.
    expect(corpusContentHash(changed)).not.toBe(stored.contentHash);

    expect(
      planCorpusDocumentWrite({ documentId, jurisdiction, ...changed, stored }),
    ).toMatchObject({
      type: "put",
      written: { contentHash: corpusContentHash(changed) },
    });
  });

  test("writes when the recorded write lives under another jurisdiction", () => {
    // Same payload, same hash, different partition: the keys must move, so
    // hash equality alone may not skip the write.
    const stored = recordedWrite(documentId, "CZE");
    const plan = planCorpusDocumentWrite({
      documentId,
      jurisdiction,
      ...documentPayload,
      stored,
    });
    expect(stored.contentHash).toBe(corpusContentHash(documentPayload));
    expect(plan.type).toBe("put");
  });

  test("a row without all four pointer columns records no write", () => {
    expect(
      storedCorpusWrite({
        textS3Key: "legal-corpus/documents/jurisdiction=SVK/x/hash/text.zst",
        normalizedS3Key: null,
        astS3Key: null,
        contentHash: null,
      }),
    ).toBeNull();
    const stored = recordedWrite(documentId, jurisdiction);
    expect(
      storedCorpusWrite({
        textS3Key: stored.textKey,
        normalizedS3Key: stored.sectionsKey,
        astS3Key: stored.astKey,
        contentHash: stored.contentHash,
      }),
    ).toEqual(stored);
  });
});

describe("readCorpusBytesAt", () => {
  const packKey = "legal-corpus/packs/jurisdiction=SVK/01912f6a.pack";
  const pack = new Uint8Array(64).map((_, index) => index);
  const fakeRange = async ({
    key,
    offset,
    length,
  }: {
    key: string;
    offset: number;
    length: number;
  }): Promise<Uint8Array> => {
    expect(key).toBe(packKey);
    return await Promise.resolve(pack.subarray(offset, offset + length));
  };
  const neverObject = async (): Promise<Uint8Array> =>
    await Promise.reject(new Error("object read must not run"));
  const neverRange = async (): Promise<Uint8Array> =>
    await Promise.reject(new Error("range read must not run"));

  test("a packed address reads exactly its range through the range reader", async () => {
    const bytes = await readCorpusBytesAt({
      location: { type: "packed", packKey, offset: 10, length: 5 },
      maxBytes: 1024,
      signal: new AbortController().signal,
      readObject: neverObject,
      readRange: fakeRange,
    });

    expect([...bytes]).toEqual([10, 11, 12, 13, 14]);
  });

  test("a packed address whose length exceeds the ceiling is refused before any read", async () => {
    let ranges = 0;
    const rejection: unknown = await readCorpusBytesAt({
      location: { type: "packed", packKey, offset: 0, length: 1025 },
      maxBytes: 1024,
      signal: new AbortController().signal,
      readObject: neverObject,
      readRange: async (options) => {
        ranges += 1;
        return await fakeRange(options);
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(PayloadBudgetError);
    expect(ranges).toBe(0);
  });

  test("an object key reads through the bounded object reader", async () => {
    const seen: { key: string; maxBytes: number }[] = [];
    const bytes = await readCorpusBytesAt({
      location: { type: "object", key: "legal-corpus/x/text.zst" },
      maxBytes: 77,
      signal: new AbortController().signal,
      readObject: async ({ key, maxBytes }) => {
        seen.push({ key, maxBytes });
        return await Promise.resolve(new Uint8Array([1, 2, 3]));
      },
      readRange: neverRange,
    });

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(seen).toEqual([{ key: "legal-corpus/x/text.zst", maxBytes: 77 }]);
  });

  test("readCorpusText accepts a packed address as its stored key", async () => {
    // The member bytes are the same zstd frame a standalone object holds.
    const member = zstdCompress("packed corpus text");
    const address = formatCorpusLocation({
      type: "packed",
      packKey,
      offset: 3,
      length: member.byteLength,
    });
    expect(parseCorpusLocation(address)).toMatchObject({ type: "packed" });

    // Only the byte sources are stubbed; the stored value still travels
    // through the reader's own parsing and routing, so the range reader is
    // what must serve it, with the offset and length the address carries.
    const seen: { key: string; offset: number; length: number }[] = [];
    const text = await readCorpusText(address, {
      readObject: neverObject,
      readRange: async ({ key, offset, length }) => {
        seen.push({ key, offset, length });
        return await Promise.resolve(member);
      },
      timeoutMs: 1000,
    });

    expect(text).toBe("packed corpus text");
    expect(seen).toEqual([
      { key: packKey, offset: 3, length: member.byteLength },
    ]);
  });

  test("the packed length check and the object ceiling share the transfer bound", async () => {
    const seen: number[] = [];
    await readCorpusText("legal-corpus/x/text.zst", {
      readObject: async ({ maxBytes }) => {
        seen.push(maxBytes);
        return await Promise.resolve(zstdCompress("x"));
      },
      timeoutMs: 1000,
    });
    const atBound = formatCorpusLocation({
      type: "packed",
      packKey,
      offset: 0,
      length: CORPUS_TRANSFER_MAX_BYTES,
    });
    const pastBound = formatCorpusLocation({
      type: "packed",
      packKey,
      offset: 0,
      length: CORPUS_TRANSFER_MAX_BYTES + 1,
    });
    const rangeReads: number[] = [];
    const readRange = async ({ length }: { length: number }) => {
      rangeReads.push(length);
      return await Promise.resolve(zstdCompress("x"));
    };

    await readCorpusText(atBound, { readObject: neverObject, readRange });
    const rejection: unknown = await readCorpusText(pastBound, {
      readObject: neverObject,
      readRange,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(seen).toEqual([CORPUS_TRANSFER_MAX_BYTES]);
    expect(rangeReads).toEqual([CORPUS_TRANSFER_MAX_BYTES]);
    expect(rejection).toBeInstanceOf(PayloadBudgetError);
  });
});

describe("deleteCorpusDocument", () => {
  const objectKey =
    "legal-corpus/documents/jurisdiction=SVK/d/h/sections.json.zst";
  const packedLocation: PackedCorpusLocation = {
    type: "packed",
    packKey: "legal-corpus/packs/jurisdiction=SVK/01912f6a.pack",
    offset: 128,
    length: 64,
  };
  const packedAddress = formatCorpusLocation(packedLocation);

  test("a packed address issues no DELETE and reports the shared object retained", async () => {
    const deleted: string[] = [];
    const outcome = await deleteCorpusDocument(
      { textKey: packedAddress, sectionsKey: objectKey, astKey: null },
      {
        deleteObject: async (key) => {
          deleted.push(key);
          await Promise.resolve();
        },
      },
    );

    expect(deleted).toEqual([objectKey]);
    expect(outcome).toEqual({
      type: "shared-object-retained",
      deletedKeys: [objectKey],
      retained: [packedLocation],
    });
  });

  test("plain object keys are deleted and reported as such", async () => {
    const deleted: string[] = [];
    const outcome = await deleteCorpusDocument(
      {
        textKey: "legal-corpus/documents/jurisdiction=SVK/d/h/text.zst",
        sectionsKey: null,
        astKey: "legal-corpus/documents/jurisdiction=SVK/d/h/ast.json.zst",
      },
      {
        deleteObject: async (key) => {
          deleted.push(key);
          await Promise.resolve();
        },
      },
    );

    expect(deleted).toHaveLength(2);
    expect(outcome).toEqual({ type: "deleted", keys: deleted });
  });
});
