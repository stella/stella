/**
 * The loaded-document cache — decision logic only.
 *
 * The hosted editor keeps one Folio instance alive across a pane swap, but a
 * route change, a tab reopen, or a genuine field-id replacement after a new
 * version still builds a fresh one. TanStack Query drops the downloaded bytes
 * five minutes after the last observer unmounts, so those rebuilds pay the
 * download again — and a freshly downloaded `ArrayBuffer` is a new object even
 * when the bytes are identical, which makes Folio reparse a document it just
 * had.
 *
 * This cache holds the bytes past that window and, more importantly, holds the
 * *same* buffer object, so `shareFileData` can hand the identical reference
 * back and the parse is skipped too.
 *
 * It is a cache of pristine loaded documents, never of edits: an in-flight
 * edit session's buffer takes precedence inside the editor
 * (`selectDocxBrowserEditorBuffer`), and nothing here may replace it.
 */

/** Small on purpose: DOCX buffers are megabytes, not kilobytes. */
export const DOCX_DOCUMENT_CACHE_LIMIT = 6;

export type DocxDocumentCacheValue = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  buffer: ArrayBuffer;
};

export type DocxDocumentCacheEntry = {
  key: string;
  value: DocxDocumentCacheValue;
  /** When the server handed these bytes over. Carried so a reopen restores the
   *  query's own staleness instead of pretending the document is fresh: within
   *  the normal window it costs no request, past it the query revalidates as it
   *  always would. */
  dataUpdatedAt: number;
  /** Monotonic use counter. Eviction takes the smallest, so the order is
   *  least-recently-used, counting a read as a use. */
  usedAt: number;
};

export type DocxDocumentCache = readonly DocxDocumentCacheEntry[];

export const EMPTY_DOCX_DOCUMENT_CACHE: DocxDocumentCache = [];

/** Keyed per (matter, file field): a field id already names one document. */
export const docxDocumentCacheKey = ({
  workspaceId,
  fileFieldId,
}: {
  workspaceId: string;
  fileFieldId: string;
}): string => `${workspaceId}:${fileFieldId}`;

export type DocxDocumentCacheRead =
  | { type: "hit"; entry: DocxDocumentCacheEntry; cache: DocxDocumentCache }
  | { type: "miss" };

/**
 * Read through the cache. A hit returns the refreshed cache too: reading is a
 * use, so the entry moves to the back of the eviction queue.
 */
export const readDocxDocumentCache = (
  cache: DocxDocumentCache,
  { key, now }: { key: string; now: number },
): DocxDocumentCacheRead => {
  const entry = cache.find((held) => held.key === key);
  if (entry === undefined) {
    return { type: "miss" };
  }

  return {
    type: "hit",
    entry,
    cache: cache.map((held) =>
      held.key === key ? { ...held, usedAt: now } : held,
    ),
  };
};

type WriteOptions = {
  key: string;
  value: DocxDocumentCacheValue;
  dataUpdatedAt: number;
  now: number;
  limit: number;
};

/**
 * Store a loaded document, evicting the least recently used entries until the
 * cache is back within its limit. A write for an existing key replaces the
 * value in place and counts as a use.
 */
export const writeDocxDocumentCache = (
  cache: DocxDocumentCache,
  { key, value, dataUpdatedAt, now, limit }: WriteOptions,
): DocxDocumentCache => {
  const held = cache.find((entry) => entry.key === key);
  if (held?.value === value) {
    // Same object back from a refetch that structurally shared: nothing to
    // store, but the read that produced it is still a use, and the server
    // vouched for the bytes again.
    return cache.map((entry) =>
      entry.key === key ? { ...entry, dataUpdatedAt, usedAt: now } : entry,
    );
  }

  const next = [
    ...cache.filter((entry) => entry.key !== key),
    { dataUpdatedAt, key, value, usedAt: now },
  ];
  if (next.length <= limit) {
    return next;
  }

  const evictCount = next.length - limit;
  const evicted = new Set(
    [...next]
      .toSorted((left, right) => left.usedAt - right.usedAt)
      .slice(0, evictCount)
      .map((entry) => entry.key),
  );
  return next.filter((entry) => !evicted.has(entry.key));
};

/**
 * Forget a document. Called when a new version replaces the field id and when
 * a version upload rewrites the field's bytes: a stale pristine buffer served
 * after either would show the previous version.
 */
export const invalidateDocxDocumentCache = (
  cache: DocxDocumentCache,
  keys: readonly string[],
): DocxDocumentCache => {
  const dropped = new Set(keys);
  const next = cache.filter((entry) => !dropped.has(entry.key));
  return next.length === cache.length ? cache : next;
};
