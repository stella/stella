import { describe, expect, test } from "bun:test";

import {
  DOCX_DOCUMENT_CACHE_LIMIT,
  EMPTY_DOCX_DOCUMENT_CACHE,
  docxDocumentCacheKey,
  invalidateDocxDocumentCache,
  readDocxDocumentCache,
  writeDocxDocumentCache,
} from "./docx-document-cache.logic";
import type {
  DocxDocumentCache,
  DocxDocumentCacheValue,
} from "./docx-document-cache.logic";

const documentValue = (fileId: string): DocxDocumentCacheValue => ({
  buffer: new Uint8Array([1, 2, 3]).buffer,
  fileId,
  fileName: `${fileId}.docx`,
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  originalMimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

const seed = (keys: readonly string[]): DocxDocumentCache => {
  let cache = EMPTY_DOCX_DOCUMENT_CACHE;
  for (const [index, key] of keys.entries()) {
    cache = writeDocxDocumentCache(cache, {
      dataUpdatedAt: index,
      key,
      limit: DOCX_DOCUMENT_CACHE_LIMIT,
      now: index,
      value: documentValue(key),
    });
  }
  return cache;
};

describe("loaded-document cache: keys", () => {
  test("a matter and a file field name one document", () => {
    expect(
      docxDocumentCacheKey({ fileFieldId: "field-1", workspaceId: "matter-1" }),
    ).toBe("matter-1:field-1");
    expect(
      docxDocumentCacheKey({ fileFieldId: "field-1", workspaceId: "matter-2" }),
    ).not.toBe(
      docxDocumentCacheKey({ fileFieldId: "field-1", workspaceId: "matter-1" }),
    );
  });
});

describe("loaded-document cache: hit and miss", () => {
  test("a hit hands back the same buffer object, so nothing reparses", () => {
    const value = documentValue("file-1");
    const cache = writeDocxDocumentCache(EMPTY_DOCX_DOCUMENT_CACHE, {
      dataUpdatedAt: 1700,
      key: "a",
      limit: DOCX_DOCUMENT_CACHE_LIMIT,
      now: 1,
      value,
    });

    const read = readDocxDocumentCache(cache, { key: "a", now: 2 });
    expect(read.type).toBe("hit");
    if (read.type !== "hit") {
      return;
    }
    expect(read.entry.value.buffer).toBe(value.buffer);
    // The fetch time travels with the bytes, so a reopen keeps the query's own
    // staleness rather than claiming a cached copy is fresh.
    expect(read.entry.dataUpdatedAt).toBe(1700);
  });

  test("an unknown document misses", () => {
    expect(readDocxDocumentCache(seed(["a"]), { key: "b", now: 1 }).type).toBe(
      "miss",
    );
  });

  test("a read counts as a use and moves the entry out of the evict queue", () => {
    const cache = seed(["a", "b"]);
    const read = readDocxDocumentCache(cache, { key: "a", now: 99 });
    expect(read.type).toBe("hit");
    if (read.type !== "hit") {
      return;
    }

    // "a" was written first, so without the read it would be evicted first.
    const full = writeDocxDocumentCache(read.cache, {
      dataUpdatedAt: 100,
      key: "c",
      limit: 2,
      now: 100,
      value: documentValue("file-c"),
    });
    expect(full.map((entry) => entry.key)).toEqual(["a", "c"]);
  });
});

describe("loaded-document cache: writing and eviction", () => {
  test("a rewrite replaces the value in place rather than growing the cache", () => {
    const first = documentValue("file-1");
    const second = documentValue("file-2");
    const cache = writeDocxDocumentCache(
      writeDocxDocumentCache(EMPTY_DOCX_DOCUMENT_CACHE, {
        dataUpdatedAt: 1,
        key: "a",
        limit: DOCX_DOCUMENT_CACHE_LIMIT,
        now: 1,
        value: first,
      }),
      {
        dataUpdatedAt: 2,
        key: "a",
        limit: DOCX_DOCUMENT_CACHE_LIMIT,
        now: 2,
        value: second,
      },
    );

    expect(cache).toHaveLength(1);
    expect(cache.at(0)?.value).toBe(second);
  });

  test("the same object back from a refetch is a use, not a rewrite", () => {
    const value = documentValue("file-1");
    const cache = writeDocxDocumentCache(EMPTY_DOCX_DOCUMENT_CACHE, {
      dataUpdatedAt: 1,
      key: "a",
      limit: DOCX_DOCUMENT_CACHE_LIMIT,
      now: 1,
      value,
    });
    const again = writeDocxDocumentCache(cache, {
      dataUpdatedAt: 9,
      key: "a",
      limit: DOCX_DOCUMENT_CACHE_LIMIT,
      now: 5,
      value,
    });

    expect(again).toHaveLength(1);
    expect(again.at(0)?.usedAt).toBe(5);
    expect(again.at(0)?.dataUpdatedAt).toBe(9);
  });

  test("eviction takes the least recently used first, oldest to newest", () => {
    const cache = seed(["a", "b", "c"]);
    const evicted = writeDocxDocumentCache(cache, {
      dataUpdatedAt: 10,
      key: "d",
      limit: 2,
      now: 10,
      value: documentValue("file-d"),
    });

    expect(evicted.map((entry) => entry.key)).toEqual(["c", "d"]);
  });

  test("the cache never grows past its limit", () => {
    const overfilled = Array.from(
      { length: DOCX_DOCUMENT_CACHE_LIMIT + 4 },
      (_, index) => `key-${index}`,
    );
    const cache = seed(overfilled);

    expect(cache).toHaveLength(DOCX_DOCUMENT_CACHE_LIMIT);
    expect(cache.map((entry) => entry.key)).toEqual(
      overfilled.slice(overfilled.length - DOCX_DOCUMENT_CACHE_LIMIT),
    );
  });

  test("six documents is the ceiling", () => {
    expect(DOCX_DOCUMENT_CACHE_LIMIT).toBe(6);
  });
});

describe("loaded-document cache: invalidation", () => {
  test("a new version's field-id replacement forgets both the old and new keys", () => {
    const cache = seed(["a", "b", "c"]);
    const invalidated = invalidateDocxDocumentCache(cache, ["a", "c"]);

    expect(invalidated.map((entry) => entry.key)).toEqual(["b"]);
  });

  test("invalidating what the cache never held changes nothing", () => {
    const cache = seed(["a"]);
    expect(invalidateDocxDocumentCache(cache, ["z"])).toBe(cache);
  });
});
