import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_FETCH_EVENT,
  type DocumentStageObservation,
} from "@stll/legal-atlas/document-fetch-diagnostics";

import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  EMPTY_AST,
  type IngestionResult,
  type SyncPage,
} from "@/api/lib/legal-search/ingestion-types";

import {
  observePublisherDocumentFetch,
  withDocumentStageWindow,
} from "./document-stage-observation";

const decision = (fulltext: string): IngestionResult => ({
  caseNumber: "fixture",
  court: "fixture",
  country: "CZE",
  language: "cs",
  fulltext,
  metadata: {},
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash: "fixture",
  documentAst: EMPTY_AST,
});

describe("document-stage observation windows", () => {
  test("successful documents, failed requests and listing-only results have distinct accounting", async () => {
    const observations: DocumentStageObservation[] = [];
    let clock = 0;
    const page = Result.ok({
      decisions: [
        decision("text"),
        decision("   "),
        { ...decision("text"), documentDelivery: "deferred" },
      ],
      nextCursor: null,
    } satisfies SyncPage);
    const result = await withDocumentStageWindow({
      source: ADAPTER_KEYS.CZ_NSS,
      observe: (event) => {
        observations.push(event);
      },
      now: () => clock,
      fetchPage: async () => {
        for (const status of [200, 503]) {
          await observePublisherDocumentFetch({
            source: ADAPTER_KEYS.CZ_NSS,
            fetch: async () => new Response(null, { status }),
          });
        }
        clock = 2000;
        return page;
      },
    });
    expect(result).toBe(page);
    expect(observations.map(({ event }) => event)).toEqual([
      DOCUMENT_FETCH_EVENT.fetchOutcome,
      DOCUMENT_FETCH_EVENT.fetchOutcome,
      DOCUMENT_FETCH_EVENT.window,
    ]);
    expect(observations.at(-1)).toEqual({
      event: DOCUMENT_FETCH_EVENT.window,
      aggregation: "page",
      source: ADAPTER_KEYS.CZ_NSS,
      backlog: 1,
      attempted: 2,
      filled: 1,
      failed: 1,
      window_seconds: 2,
    });
  });

  test("empty pages emit an observable zero window", async () => {
    const observations: DocumentStageObservation[] = [];
    await withDocumentStageWindow({
      source: ADAPTER_KEYS.CZ_NSS,
      fetchPage: async () => Result.ok({ decisions: [], nextCursor: null }),
      now: () => 42,
      observe: (event) => {
        observations.push(event);
      },
    });
    expect(observations).toEqual([
      {
        event: DOCUMENT_FETCH_EVENT.window,
        aggregation: "page",
        source: ADAPTER_KEYS.CZ_NSS,
        backlog: 0,
        attempted: 0,
        filled: 0,
        failed: 0,
        window_seconds: 0,
      },
    ]);
  });

  test("listing-only documents remain observable backlog even when the adapter returns the page", async () => {
    const observations: DocumentStageObservation[] = [];
    await withDocumentStageWindow({
      source: ADAPTER_KEYS.CZ_NSS,
      now: () => 0,
      observe: (event) => {
        observations.push(event);
      },
      fetchPage: async () =>
        Result.ok({
          decisions: [{ ...decision(""), isListingOnly: true }],
          nextCursor: null,
        }),
    });
    expect(observations.at(-1)).toEqual({
      event: DOCUMENT_FETCH_EVENT.window,
      aggregation: "page",
      source: ADAPTER_KEYS.CZ_NSS,
      backlog: 1,
      attempted: 1,
      filled: 0,
      failed: 1,
      window_seconds: 0,
    });
  });

  test("nested errors produce one failure and preserve the exact error result", async () => {
    const observations: DocumentStageObservation[] = [];
    const cause = Object.assign(new Error("private"), { code: "ECONNREFUSED" });
    const failure = Result.err(
      new AdapterFetchError({
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: null,
        message: "private",
        cause,
      }),
    );
    const result = await withDocumentStageWindow({
      source: ADAPTER_KEYS.CZ_NSS,
      observe: (event) => {
        observations.push(event);
      },
      now: () => 0,
      fetchPage: async () => {
        await Result.tryPromise({
          try: async () =>
            await observePublisherDocumentFetch({
              source: ADAPTER_KEYS.CZ_NSS,
              fetch: async () => {
                throw cause;
              },
            }),
          catch: (error) => error,
        });
        return failure;
      },
    });
    expect(result).toBe(failure);
    expect(observations).toEqual([
      {
        event: DOCUMENT_FETCH_EVENT.fetchOutcome,
        source: ADAPTER_KEYS.CZ_NSS,
        outcome: "connection",
      },
      {
        event: DOCUMENT_FETCH_EVENT.window,
        aggregation: "page",
        source: ADAPTER_KEYS.CZ_NSS,
        backlog: 1,
        attempted: 1,
        filled: 0,
        failed: 1,
        window_seconds: 0,
      },
    ]);
  });

  test("thrown page failures still report and preserve the original error", async () => {
    const observations: DocumentStageObservation[] = [];
    const error = new DOMException("private", "TimeoutError");
    const run = withDocumentStageWindow({
      source: ADAPTER_KEYS.CZ_NSS,
      fetchPage: async () => {
        throw error;
      },
      observe: (event) => {
        observations.push(event);
      },
      now: () => 0,
    });
    await expect(run).rejects.toBe(error);
    expect(observations.at(0)).toEqual({
      event: DOCUMENT_FETCH_EVENT.fetchOutcome,
      source: ADAPTER_KEYS.CZ_NSS,
      outcome: "timeout",
    });
    expect(observations.at(-1)).toMatchObject({
      aggregation: "page",
      failed: 1,
      filled: 0,
      attempted: 1,
    });
  });

  test("concurrent sources retain their own callbacks and counters", async () => {
    const sources = [ADAPTER_KEYS.CZ_NSS, ADAPTER_KEYS.SK_US] as const;
    const results = await Promise.all(
      sources.map(async (source) => {
        const observations: DocumentStageObservation[] = [];
        await withDocumentStageWindow({
          source,
          observe: (event) => {
            observations.push(event);
          },
          now: () => 0,
          fetchPage: async () => {
            await Promise.resolve();
            await observePublisherDocumentFetch({
              source,
              fetch: async () =>
                new Response(null, {
                  status: source === ADAPTER_KEYS.CZ_NSS ? 200 : 429,
                }),
            });
            return Result.ok({
              decisions:
                source === ADAPTER_KEYS.CZ_NSS ? [decision("text")] : [],
              nextCursor: null,
            });
          },
        });
        expect(observations.every((event) => event.source === source)).toBe(
          true,
        );
        return observations.at(-1);
      }),
    );
    expect(results).toEqual([
      {
        event: DOCUMENT_FETCH_EVENT.window,
        aggregation: "page",
        source: ADAPTER_KEYS.CZ_NSS,
        backlog: 0,
        attempted: 1,
        filled: 1,
        failed: 0,
        window_seconds: 0,
      },
      {
        event: DOCUMENT_FETCH_EVENT.window,
        aggregation: "page",
        source: ADAPTER_KEYS.SK_US,
        backlog: 1,
        attempted: 1,
        filled: 0,
        failed: 1,
        window_seconds: 0,
      },
    ]);
  });

  test("PDF challenges are typed without consuming or replacing the response", async () => {
    for (const mime of [
      "text/html",
      "application/json",
      "",
      "application/pdf",
      "application/octet-stream",
    ]) {
      const response = new Response("private", {
        headers: { "content-type": mime },
      });
      const observations: DocumentStageObservation[] = [];
      await withDocumentStageWindow({
        source: ADAPTER_KEYS.CZ_NSS,
        observe: (event) => {
          observations.push(event);
        },
        now: () => 0,
        fetchPage: async () => {
          expect(
            await observePublisherDocumentFetch({
              source: ADAPTER_KEYS.CZ_NSS,
              fetch: async () => response,
              expectedContentType: "pdf",
            }),
          ).toBe(response);
          expect(response.bodyUsed).toBe(false);
          return Result.ok({ decisions: [], nextCursor: null });
        },
      });
      expect(observations.at(0)).toEqual({
        event: DOCUMENT_FETCH_EVENT.fetchOutcome,
        source: ADAPTER_KEYS.CZ_NSS,
        outcome:
          mime === "application/pdf" || mime === "application/octet-stream"
            ? "ok"
            : "body_shape",
        http_status: 200,
      });
    }
  });
});
