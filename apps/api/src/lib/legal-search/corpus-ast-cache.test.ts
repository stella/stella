import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { propertyConfig } from "@stll/property-testing";

import { createCorpusAstCache } from "@/api/lib/legal-search/corpus-ast-cache";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type { SizedCorpusAst } from "@/api/lib/legal-search/corpus-storage";

const astFor = (storedKey: string): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: storedKey, webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "p1",
      anchorId: "par_1",
      type: "paragraph",
      inlines: [{ type: "text", text: "§ 1" }],
      plainText: "§ 1",
    },
  ],
});

type FakeStoreOptions = {
  /** Decoded length each key reports; defaults to 1000 characters. */
  lengths?: Record<string, number>;
  failing?: Set<string>;
};

/** A payload store that counts how often each key is read. */
const fakeStore = ({ lengths = {}, failing = new Set() }: FakeStoreOptions) => {
  const reads = new Map<string, number>();
  const read = async (storedKey: string): Promise<SizedCorpusAst> => {
    reads.set(storedKey, (reads.get(storedKey) ?? 0) + 1);
    await Promise.resolve();
    if (failing.has(storedKey)) {
      throw new Error(`object store unavailable: ${storedKey}`);
    }
    return {
      ast: astFor(storedKey),
      decodedLength: lengths[storedKey] ?? 1000,
    };
  };
  return { read, readsOf: (storedKey: string) => reads.get(storedKey) ?? 0 };
};

const OBJECT_KEY =
  "legal-corpus/documents/jurisdiction=CZE/doc/0000000000000000000000000000000000000000000000000000000000000001/ast.json.zst";

describe("a consolidation read through the AST cache", () => {
  test("is fetched and parsed once however often its provisions are read", async () => {
    const store = fakeStore({});
    const cache = createCorpusAstCache({
      maxHeapBytes: 1024 * 1024,
      read: store.read,
    });

    const first = await cache.read(OBJECT_KEY);
    await cache.read(OBJECT_KEY);
    await cache.read(OBJECT_KEY);

    expect(first).toEqual(astFor(OBJECT_KEY));
    expect(store.readsOf(OBJECT_KEY)).toBe(1);
  });

  test("is fetched once for concurrent readers", async () => {
    const store = fakeStore({});
    const cache = createCorpusAstCache({
      maxHeapBytes: 1024 * 1024,
      read: store.read,
    });

    await Promise.all(
      Array.from({ length: 6 }, async () => await cache.read(OBJECT_KEY)),
    );

    expect(store.readsOf(OBJECT_KEY)).toBe(1);
  });

  test("is frozen, so no request can change what the next one reads", async () => {
    const cache = createCorpusAstCache({
      maxHeapBytes: 1024 * 1024,
      read: fakeStore({}).read,
    });

    const ast = await cache.read(OBJECT_KEY);
    const block = ast !== null && "blocks" in ast ? ast.blocks.at(0) : null;

    expect(block?.plainText).toBe("§ 1");
    expect(() => {
      Object.assign(block ?? {}, { plainText: "changed" });
    }).toThrow(TypeError);
  });

  test("is read again after a failed read rather than remembering the failure", async () => {
    const failing = new Set([OBJECT_KEY]);
    const store = fakeStore({ failing });
    const cache = createCorpusAstCache({
      maxHeapBytes: 1024 * 1024,
      read: store.read,
    });

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection: unknown = await cache.read(OBJECT_KEY).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toContain("object store unavailable");
    failing.clear();

    expect(await cache.read(OBJECT_KEY)).toEqual(astFor(OBJECT_KEY));
    expect(store.readsOf(OBJECT_KEY)).toBe(2);
  });

  test("is always read through when it is a packed member, whose erasure each read must consult", async () => {
    const packed = formatCorpusLocation({
      type: "packed",
      packKey: "legal-corpus/packs/p1.zst",
      offset: 0,
      length: 10,
      sha256: "a".repeat(64),
    });
    const store = fakeStore({});
    const cache = createCorpusAstCache({
      maxHeapBytes: 1024 * 1024,
      read: store.read,
    });

    await cache.read(packed);
    await cache.read(packed);

    expect(store.readsOf(packed)).toBe(2);
    expect(cache.heapBytes()).toBe(0);
  });

  test("is not kept when it alone would exceed the budget", async () => {
    const store = fakeStore({ lengths: { [OBJECT_KEY]: 1_000_000 } });
    const cache = createCorpusAstCache({
      maxHeapBytes: 1_000_000,
      read: store.read,
    });

    await cache.read(OBJECT_KEY);
    await cache.read(OBJECT_KEY);

    expect(store.readsOf(OBJECT_KEY)).toBe(2);
    expect(cache.heapBytes()).toBe(0);
  });

  test("evicts the least recently read consolidation first", async () => {
    const store = fakeStore({});
    // Room for two 1000-character payloads (3000 estimated bytes each).
    const cache = createCorpusAstCache({
      maxHeapBytes: 6000,
      read: store.read,
    });

    await cache.read("a");
    await cache.read("b");
    await cache.read("a");
    await cache.read("c");
    await cache.read("a");
    await cache.read("b");

    expect(store.readsOf("a")).toBe(1);
    expect(store.readsOf("b")).toBe(2);
    expect(store.readsOf("c")).toBe(1);
  });
});

test("the cache never holds more than its budget, whatever the read sequence", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 50_000 }),
      fc.array(
        fc.record({
          key: fc.constantFrom("a", "b", "c", "d", "e", "f"),
          decodedLength: fc.integer({ min: 0, max: 20_000 }),
        }),
        { maxLength: 60 },
      ),
      async (maxHeapBytes, reads) => {
        // A key's payload is immutable, so its length is fixed per key.
        const lengths: Record<string, number> = {};
        for (const { key, decodedLength } of reads) {
          lengths[key] ??= decodedLength;
        }
        const cache = createCorpusAstCache({
          maxHeapBytes,
          read: fakeStore({ lengths }).read,
        });
        for (const { key } of reads) {
          await cache.read(key);
          expect(cache.heapBytes()).toBeLessThanOrEqual(maxHeapBytes);
          expect(cache.heapBytes()).toBeGreaterThanOrEqual(0);
        }
      },
    ),
    propertyConfig(),
  );
});
