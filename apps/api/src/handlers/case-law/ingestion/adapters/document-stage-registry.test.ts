import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_FETCH_EVENT,
  type DocumentStageObservation,
} from "@stll/legal-atlas/document-fetch-diagnostics";

import { defineSourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import {
  listAdapters,
  listDocumentStageAdapters,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { observePublisherDocumentFetch } from "@/api/lib/legal-search/document-stage-observation";
import { exceptionFingerprint } from "@/api/lib/observability/exception-fingerprint";
import { getExceptionScope } from "@/api/lib/observability/exception-scope";
import { readEvidence } from "@/api/lib/observability/failure-evidence";

describe("registered document stages", () => {
  test("the document-stage census is derived from the entire adapter registry", () => {
    expect(listDocumentStageAdapters()).toEqual(
      listAdapters().map(({ key, documentStage }) => ({ key, documentStage })),
    );
    expect(
      new Set(listDocumentStageAdapters().map(({ key }) => key)).size,
    ).toBe(listAdapters().length);
    for (const { documentStage } of listDocumentStageAdapters()) {
      expect(["inline", "deferred"]).toContain(documentStage);
    }
  });

  test("every registered stage emits source-bound windows and typed document failures", async () => {
    for (const adapter of listAdapters()) {
      const observations: DocumentStageObservation[] = [];
      const page = Result.err(
        new AdapterFetchError({
          adapterKey: adapter.key,
          cursor: null,
          message: "fixture",
          httpStatus: 429,
        }),
      );
      expect(
        await adapter.observeDocumentStage({
          now: () => 0,
          observe: (observation) => {
            observations.push(observation);
          },
          fetchPage: async () => {
            await observePublisherDocumentFetch({
              source: adapter.key,
              fetch: async () => new Response(null, { status: 429 }),
            });
            return page;
          },
        }),
      ).toBe(page);
      expect(observations).toEqual([
        {
          event: DOCUMENT_FETCH_EVENT.fetchOutcome,
          source: adapter.key,
          outcome: "rate_limited",
          http_status: 429,
        },
        {
          event: DOCUMENT_FETCH_EVENT.window,
          aggregation: "page",
          source: adapter.key,
          backlog: 1,
          attempted: 1,
          filled: 0,
          failed: 1,
          window_seconds: 0,
        },
      ]);
    }
  });

  test("the factory wires its page entrypoint through the registered stage observer", async () => {
    for (const registered of listAdapters()) {
      const observations: DocumentStageObservation[] = [];
      const page = Result.ok({ decisions: [], nextCursor: null });
      const adapter = defineSourceAdapter({
        ...registered,
        fetchPage: async () => {
          await observePublisherDocumentFetch({
            source: registered.key,
            fetch: async () => new Response(null, { status: 503 }),
          });
          return page;
        },
      });
      expect(
        await adapter.fetchPage(null, {}, undefined, (event) => {
          observations.push(event);
        }),
      ).toBe(page);
      expect(observations).toHaveLength(2);
      expect(observations.at(0)).toEqual({
        event: DOCUMENT_FETCH_EVENT.fetchOutcome,
        source: registered.key,
        outcome: "http_5xx",
        http_status: 503,
      });
      expect(observations.at(-1)).toMatchObject({
        event: DOCUMENT_FETCH_EVENT.window,
        aggregation: "page",
        source: registered.key,
        failed: 1,
        filled: 0,
      });
    }
  });
});

test("adapter ownership scopes nested count and factory-created builder failures separately", async () => {
  const fingerprints: string[] = [];
  const sources = listAdapters().slice(0, 2);
  expect(sources).toHaveLength(2);
  for (const registered of sources) {
    const recordNestedFailure = () => {
      const scope = getExceptionScope();
      expect(scope).toEqual({ type: "ingestion", adapterKey: registered.key });
      if (scope !== undefined) {
        fingerprints.push(
          exceptionFingerprint(readEvidence(new Error("private")), {
            fingerprintKey: "shared.recordNestedFailure",
            scope,
          }),
        );
      }
    };
    const adapter = defineSourceAdapter({
      ...registered,
      getTotalCount: async () => {
        await Promise.resolve();
        recordNestedFailure();
        return { type: "no-count-endpoint" };
      },
      reconciliation: {
        ...registered.reconciliation,
        createSliceBuildDecision: () => async () => {
          await Promise.resolve();
          recordNestedFailure();
          return { type: "unkeyable" };
        },
      },
    });
    await adapter.getTotalCount(new AbortController().signal);
    const build = adapter.reconciliation.createSliceBuildDecision?.();
    expect(build).toBeDefined();
    await build?.({});
    expect(getExceptionScope()).toBeUndefined();
  }
  expect(fingerprints).toHaveLength(4);
  expect(new Set(fingerprints).size).toBe(2);
});
