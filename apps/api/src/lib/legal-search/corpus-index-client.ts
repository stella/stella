import { panic, Result, TaggedError } from "better-result";

import { envBase } from "@/api/env-base";
import type { CorpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";

/**
 * Thin lazy HTTP client over corpus index's REST API. Built on first use
 * (no import-time side effects); every call has a timeout and returns a
 * typed Result. corpus index is purely the lexical first stage — the
 * citation-authority blend happens in the rerank util, not here.
 */

export class CorpusIndexError extends TaggedError("CorpusIndexError")<{
  message: string;
  status?: number | undefined;
  cause?: unknown;
}>() {}

const SEARCH_TIMEOUT_MS = 30_000;
const INGEST_TIMEOUT_MS = 120_000;
const ADMIN_TIMEOUT_MS = 30_000;

export type CorpusIndexSearchInput = {
  indexId: string;
  /** Full corpus index query string, including any field:value filter clauses. */
  query: string;
  maxHits: number;
  startOffset?: number | undefined;
  sortByField?: string | undefined;
  snippetFields?: string[] | undefined;
};

export type CorpusIndexHit = Record<string, unknown>;

export type CorpusIndexSearchResponse = {
  numHits: number;
  hits: CorpusIndexHit[];
  snippets: Record<string, unknown>[];
};

export type CorpusIndexClient = {
  createIndex: (
    config: CorpusIndexConfig,
  ) => Promise<Result<void, CorpusIndexError>>;
  deleteIndex: (indexId: string) => Promise<Result<void, CorpusIndexError>>;
  indexExists: (indexId: string) => Promise<Result<boolean, CorpusIndexError>>;
  ingestBatch: (
    indexId: string,
    ndjson: string,
  ) => Promise<Result<void, CorpusIndexError>>;
  search: (
    input: CorpusIndexSearchInput,
  ) => Promise<Result<CorpusIndexSearchResponse, CorpusIndexError>>;
  deleteByQuery: (
    indexId: string,
    query: string,
  ) => Promise<Result<void, CorpusIndexError>>;
};

const baseUrl = (): string => {
  const value = envBase.CORPUS_INDEX_ENDPOINT;
  if (value === undefined || value.length === 0) {
    panic(
      "CORPUS_INDEX_ENDPOINT is required when the corpus index search provider is selected",
    );
  }
  // eslint-disable-next-line sonarjs/slow-regex -- trims trailing slashes on a trusted config URL, not user input
  return value.replace(/\/+$/u, "");
};

const toCorpusIndexError = (error: unknown): CorpusIndexError =>
  error instanceof CorpusIndexError
    ? error
    : new CorpusIndexError({
        message:
          error instanceof Error
            ? error.message
            : "corpus index request failed",
        cause: error,
      });

const requestJson = async <T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> => {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CorpusIndexError({
      message: `corpus index ${init.method ?? "GET"} ${path} -> ${response.status}: ${body.slice(0, 500)}`,
      status: response.status,
    });
  }
  // SAFETY: the JSON shape is the caller's declared contract at the
  // corpus index HTTP boundary; callers read fields defensively.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as T;
};

const buildClient = (): CorpusIndexClient => ({
  createIndex: async (config) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson<unknown>(
          "/api/v1/indexes",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(config),
          },
          ADMIN_TIMEOUT_MS,
        );
      },
      catch: toCorpusIndexError,
    }),

  deleteIndex: async (indexId) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson<unknown>(
          `/api/v1/indexes/${indexId}`,
          { method: "DELETE" },
          ADMIN_TIMEOUT_MS,
        );
      },
      catch: toCorpusIndexError,
    }),

  indexExists: async (indexId) =>
    await Result.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl()}/api/v1/indexes/${indexId}`, {
          method: "GET",
          signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
        });
        if (response.status === 404) {
          return false;
        }
        if (!response.ok) {
          throw new CorpusIndexError({
            message: `corpus index GET /api/v1/indexes/${indexId} -> ${response.status}`,
            status: response.status,
          });
        }
        return true;
      },
      catch: toCorpusIndexError,
    }),

  ingestBatch: async (indexId, ndjson) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson<unknown>(
          `/api/v1/${indexId}/ingest?commit=auto`,
          {
            method: "POST",
            headers: { "content-type": "application/x-ndjson" },
            body: ndjson,
          },
          INGEST_TIMEOUT_MS,
        );
      },
      catch: toCorpusIndexError,
    }),

  search: async ({
    indexId,
    query,
    maxHits,
    startOffset,
    sortByField,
    snippetFields,
  }) =>
    await Result.tryPromise({
      try: async () => {
        const body: Record<string, unknown> = {
          query,
          max_hits: maxHits,
        };
        if (startOffset !== undefined) {
          body["start_offset"] = startOffset;
        }
        if (sortByField !== undefined) {
          body["sort_by_field"] = sortByField;
        }
        if (snippetFields !== undefined && snippetFields.length > 0) {
          body["snippet_fields"] = snippetFields.join(",");
        }
        const response = await requestJson<{
          num_hits?: number;
          hits?: CorpusIndexHit[];
          snippets?: Record<string, unknown>[];
        }>(
          `/api/v1/${indexId}/search`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          SEARCH_TIMEOUT_MS,
        );
        return {
          numHits: response.num_hits ?? 0,
          hits: response.hits ?? [],
          snippets: response.snippets ?? [],
        };
      },
      catch: toCorpusIndexError,
    }),

  deleteByQuery: async (indexId, query) =>
    await Result.tryPromise({
      try: async () => {
        await requestJson<unknown>(
          `/api/v1/${indexId}/delete-tasks`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query }),
          },
          ADMIN_TIMEOUT_MS,
        );
      },
      catch: toCorpusIndexError,
    }),
});

let cached: CorpusIndexClient | null = null;

export const getCorpusIndexClient = (): CorpusIndexClient => {
  cached ??= buildClient();
  return cached;
};
