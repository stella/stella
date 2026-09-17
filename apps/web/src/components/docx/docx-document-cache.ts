/**
 * The loaded-document cache itself. Decisions live in
 * `docx-document-cache.logic.ts`; this module holds the entries and binds
 * their lifetime to the query cache.
 *
 * TanStack Query drops a document's bytes five minutes after the last viewer
 * unmounts, and a re-download produces a new `ArrayBuffer` even for identical
 * bytes — which Folio reads as a different document and reparses. Holding the
 * same object past that window makes a reopen a cache read.
 */

import type { QueryClient } from "@tanstack/react-query";

import {
  DOCX_DOCUMENT_CACHE_LIMIT,
  EMPTY_DOCX_DOCUMENT_CACHE,
  docxDocumentCacheKey,
  invalidateDocxDocumentCache,
  readDocxDocumentCache,
  writeDocxDocumentCache,
} from "./docx-document-cache.logic";
import type { DocxDocumentCacheValue } from "./docx-document-cache.logic";

let cache = EMPTY_DOCX_DOCUMENT_CACHE;

/** A use counter rather than a clock: eviction only needs an order, and two
 *  reads inside the same millisecond still have one. */
let uses = 0;
const nextUse = () => {
  uses += 1;
  return uses;
};

type DocxDocumentRef = { workspaceId: string; fileFieldId: string };

export type DocxDocumentRead = {
  value: DocxDocumentCacheValue;
  dataUpdatedAt: number;
};

export const readDocxDocument = (
  ref: DocxDocumentRef,
): DocxDocumentRead | null => {
  const read = readDocxDocumentCache(cache, {
    key: docxDocumentCacheKey(ref),
    now: nextUse(),
  });
  if (read.type === "miss") {
    return null;
  }
  cache = read.cache;
  return {
    dataUpdatedAt: read.entry.dataUpdatedAt,
    value: read.entry.value,
  };
};

export const writeDocxDocument = (
  ref: DocxDocumentRef,
  { dataUpdatedAt, value }: DocxDocumentRead,
): void => {
  cache = writeDocxDocumentCache(cache, {
    dataUpdatedAt,
    key: docxDocumentCacheKey(ref),
    limit: DOCX_DOCUMENT_CACHE_LIMIT,
    now: nextUse(),
    value,
  });
};

export const forgetDocxDocuments = (refs: readonly DocxDocumentRef[]): void => {
  cache = invalidateDocxDocumentCache(cache, refs.map(docxDocumentCacheKey));
};

/** The bytes the DOCX editor loads. */
const NATIVE_DISPLAY_PURPOSE = "native-display";

const cacheBoundClients = new WeakSet<QueryClient>();

/**
 * Bind the cache to the query cache instead of to the call sites that write a
 * new version. Every path that invalidates a field's downloaded bytes — a
 * version upload, a save, a desktop edit landing — already does so through
 * `filesKeys.contentByFieldId`, so listening there means a new invalidation
 * cannot forget to drop the pristine copy.
 */
export const installDocxDocumentCacheInvalidation = (
  queryClient: QueryClient,
): void => {
  if (cacheBoundClients.has(queryClient)) {
    return;
  }
  cacheBoundClients.add(queryClient);

  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "invalidate") {
      return;
    }
    const ref = docxDocumentRefFromQueryKey(event.query.queryKey);
    if (ref === null) {
      return;
    }
    forgetDocxDocuments([ref]);
  });
};

/** `["files", workspaceId, fieldId, purpose]` — see `fileContentQueryKey`. */
const docxDocumentRefFromQueryKey = (
  queryKey: readonly unknown[],
): DocxDocumentRef | null => {
  const [root, workspaceId, fileFieldId, purpose] = queryKey;
  if (
    root !== "files" ||
    purpose !== NATIVE_DISPLAY_PURPOSE ||
    typeof workspaceId !== "string" ||
    typeof fileFieldId !== "string"
  ) {
    return null;
  }
  return { fileFieldId, workspaceId };
};
