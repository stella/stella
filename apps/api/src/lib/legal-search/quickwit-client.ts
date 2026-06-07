import { panic, Result, TaggedError } from "better-result";

import { envBase } from "@/api/env-base";
import type { QuickwitIndexConfig } from "@/api/lib/legal-search/quickwit-index-config";

/**
 * Thin lazy HTTP client over Quickwit's REST API. Built on first use
 * (no import-time side effects); every call has a timeout and returns a
 * typed Result. Quickwit is purely the lexical first stage — the
 * citation-authority blend happens in the rerank util, not here.
 */

export class QuickwitError extends TaggedError("QuickwitError")<{
  message: string;
  status?: number | undefined;
  cause?: unknown;
}>() {}

const SEARCH_TIMEOUT_MS = 30_000;
const INGEST_TIMEOUT_MS = 120_000;
const ADMIN_TIMEOUT_MS = 30_000;

export type QuickwitSearchInput = {
  indexId: string;
  /** Full Quickwit query string, including any field:value filter clauses. */
  query: string;
  maxHits: number;
  startOffset?: number | undefined;
  sortByField?: string | undefined;
  snippetFields?: string[] | undefined;
};

export type QuickwitHit = Record<string, unknown>;

export type QuickwitSearchResponse = {
  numHits: number;
  hits: QuickwitHit[];
  snippets: Array<Record<string, unknown>>;
};

export type QuickwitClient = {
  createIndex: (
    config: QuickwitIndexConfig,
  ) => Promise<Result<void, QuickwitError>>;
  deleteIndex: (indexId: string) => Promise<Result<void, QuickwitError>>;
  indexExists: (indexId: string) => Promise<Result<boolean, QuickwitError>>;
  ingestBatch: (
    indexId: string,
    ndjson: string,
  ) => Promise<Result<void, QuickwitError>>;
  search: (
    input: QuickwitSearchInput,
  ) => Promise<Result<QuickwitSearchResponse, QuickwitError>>;
  deleteByQuery: (
    indexId: string,
    query: string,
  ) => Promise<Result<void, QuickwitError>>;
};

const baseUrl = (): string => {
  const value = envBase.QUICKWIT_ENDPOINT;
  if (value === undefined || value.length === 0) {
    panic(
      "QUICKWIT_ENDPOINT is required when the Quickwit search provider is selected",
    );
  }
  return value.replace(/\/+$/u, "");
};

const toQuickwitError = (error: unknown): QuickwitError =>
  error instanceof QuickwitError
    ? error
    : new QuickwitError({
        message:
          error instanceof Error ? error.message : "Quickwit request failed",
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
    throw new QuickwitError({
      message: `Quickwit ${init.method ?? "GET"} ${path} -> ${response.status}: ${body.slice(0, 500)}`,
      status: response.status,
    });
  }
  // SAFETY: the JSON shape is the caller's declared contract at the
  // Quickwit HTTP boundary; callers read fields defensively.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as T;
};

const buildClient = (): QuickwitClient => ({
  createIndex: (config) =>
    Result.tryPromise({
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
      catch: toQuickwitError,
    }),

  deleteIndex: (indexId) =>
    Result.tryPromise({
      try: async () => {
        await requestJson<unknown>(
          `/api/v1/indexes/${indexId}`,
          { method: "DELETE" },
          ADMIN_TIMEOUT_MS,
        );
      },
      catch: toQuickwitError,
    }),

  indexExists: (indexId) =>
    Result.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl()}/api/v1/indexes/${indexId}`, {
          method: "GET",
          signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
        });
        if (response.status === 404) {
          return false;
        }
        if (!response.ok) {
          throw new QuickwitError({
            message: `Quickwit GET /api/v1/indexes/${indexId} -> ${response.status}`,
            status: response.status,
          });
        }
        return true;
      },
      catch: toQuickwitError,
    }),

  ingestBatch: (indexId, ndjson) =>
    Result.tryPromise({
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
      catch: toQuickwitError,
    }),

  search: ({
    indexId,
    query,
    maxHits,
    startOffset,
    sortByField,
    snippetFields,
  }) =>
    Result.tryPromise({
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
          hits?: QuickwitHit[];
          snippets?: Array<Record<string, unknown>>;
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
      catch: toQuickwitError,
    }),

  deleteByQuery: (indexId, query) =>
    Result.tryPromise({
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
      catch: toQuickwitError,
    }),
});

let cached: QuickwitClient | null = null;

export const getQuickwitClient = (): QuickwitClient => {
  cached ??= buildClient();
  return cached;
};
