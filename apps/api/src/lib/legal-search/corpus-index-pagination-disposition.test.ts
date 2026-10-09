import { afterEach, beforeEach, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  createCorpusHitDispositionCounter,
  reportCorpusHitDispositions,
  type CorpusHitDispositionCounter,
} from "@/api/lib/legal-search/corpus-hit-telemetry";
import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import {
  corpusIndexLexicalScore,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import { CORPUS_BM25_RATIO_POWER } from "@/api/lib/legal-search/corpus-ranking-policy";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { LIMITS } from "@/api/lib/limits";
import { testRevisionsFor } from "@/api/tests/helpers/corpus-projection-revisions";
import {
  installRecordingLogger,
  type RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const originalFetch = globalThis.fetch;
let logs: RecordingLogger;

beforeEach(() => {
  logs = installRecordingLogger();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  logs.restore();
});

const modes = ["native", "scored", "bm25"] as const;
type Mode = (typeof modes)[number];

const stubHits = (
  hits: readonly CorpusIndexHit[],
  highlightHits: readonly CorpusIndexHit[] = hits,
) => {
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(v.parse(v.string(), init?.body));
      if (body.snippet_fields !== undefined) {
        return Response.json({
          num_hits: highlightHits.length,
          hits: highlightHits,
          snippets: highlightHits.map((hit) => ({ text: [hit["text"]] })),
        });
      }
      if (body.from !== undefined) {
        return Response.json({
          hits: {
            total: { value: hits.length },
            hits: hits
              .map((hit, index) => ({
                _source: hit,
                _score: hits.length - index,
              }))
              .slice(body.from, body.from + body.size),
          },
        });
      }
      return Response.json({
        num_hits: hits.length,
        hits: hits.slice(body.start_offset, body.start_offset + body.max_hits),
      });
    },
    { preconnect: originalFetch.preconnect },
  );
};

const readDispositionPage = async (
  mode: Mode,
  limit = 40,
  hitDispositions?: CorpusHitDispositionCounter,
) =>
  await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "case_law_v5_cs_sk",
    query: "text:fixture",
    limit,
    order: RELEVANCE_ORDER,
    parsedCursor: null,
    hitDispositions,
    scanTransport:
      mode === "native"
        ? { type: "native" }
        : { type: "scored", fields: ["document_id"] },
    rankingMode: mode === "bm25" ? "bm25-ratio" : "off",
    snippetFields: ["text"],
    projectionRevisionField: "projection_revision",
    extractId: (hit: CorpusIndexHit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: (snippet) => {
      const text = snippet?.["text"];
      const first = Array.isArray(text) ? text.at(0) : text;
      return typeof first === "string" ? first : null;
    },
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (candidates) => ({
      context: null,
      groups: [],
      ranked: candidates.map((candidate) => ({
        ...candidate,
        lexicalScore: candidate.score,
        citationAuthority: 0,
      })),
      revisionById: testRevisionsFor(candidates),
    }),
  });

test.each(modes)(
  "%s counts malformed hits separately from repeated passages and highlight copies",
  async (mode) => {
    stubHits(
      [
        { document_id: "doc-b", text: "best b" },
        { document_id: 7 },
        { document_id: "doc-b", text: "other b" },
        { document_id: "doc-a", text: "best a" },
        { document_id: false },
      ],
      [
        { document_id: null },
        { document_id: "doc-b", text: "best b" },
        { document_id: "doc-b", text: "other b" },
        { document_id: "doc-a", text: "best a" },
      ],
    );
    const page = await readDispositionPage(mode);
    expect(page.pageRanked.map(({ id }) => id)).toEqual(["doc-b", "doc-a"]);
    expect(page.passageCountById).toEqual(
      new Map([
        ["doc-b", 2],
        ["doc-a", 1],
      ]),
    );
    expect(page.snippetById).toEqual(
      new Map([
        ["doc-b", "best b"],
        ["doc-a", "best a"],
      ]),
    );
    const records = logs.records.filter(
      ({ message }) => message === "corpus.search.hit_dispositions",
    );
    expect(records).toEqual([
      expect.objectContaining({
        severityText: "INFO",
        attributes: { malformed: 3, excluded: 0, drift: 0 },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("doc-b");
    expect(JSON.stringify(records)).not.toContain("text:fixture");
  },
);

test("a native scan with only malformed hits reports the omission on an empty page", async () => {
  stubHits([{}, { document_id: null }, { document_id: false }]);
  const page = await readDispositionPage("native");
  expect(page.pageRanked).toEqual([]);
  expect(page.scan.passagesScanned).toBe(3);
  expect(page.scan.highlightRounds).toBe(0);
  expect(
    logs.records.filter(
      ({ message }) => message === "corpus.search.hit_dispositions",
    ),
  ).toEqual([
    expect.objectContaining({
      severityText: "INFO",
      attributes: { malformed: 3, excluded: 0, drift: 0 },
    }),
  ]);
});

test("a multi-round page emits one aggregate after highlighting", async () => {
  const malformed = LIMITS.corpusIndexSearchCandidateLimit + 1;
  const validHit = { document_id: "doc-a", text: "best a" };
  stubHits(
    [
      ...Array.from({ length: malformed }, () => ({ document_id: 7 })),
      validHit,
    ],
    [validHit],
  );
  const page = await readDispositionPage("native");
  expect(page.scan.rounds).toBeGreaterThan(1);
  expect(page.snippetById.get("doc-a")).toBe("best a");
  expect(logs.records).toEqual([
    expect.objectContaining({
      message: "corpus.search.hit_dispositions",
      severityText: "INFO",
      attributes: { malformed, excluded: 0, drift: 0 },
    }),
  ]);
});

test("a caller-owned counter combines all pages and canonical read counts without intermediate logs", async () => {
  const hitDispositions = createCorpusHitDispositionCounter();
  hitDispositions.recordCanonical({ id: "excluded-a", type: "excluded" });
  hitDispositions.recordCanonical({ id: "excluded-b", type: "excluded" });
  hitDispositions.recordCanonical({ id: "missing", type: "drift" });
  stubHits(
    [{ document_id: 7 }, { document_id: "doc-a", text: "best a" }],
    [{ document_id: "doc-a", text: "best a" }],
  );
  await readDispositionPage("native", 40, hitDispositions);
  for (const id of ["excluded-c", "excluded-d", "excluded-e"]) {
    hitDispositions.recordCanonical({ id, type: "excluded" });
  }
  await readDispositionPage("scored", 40, hitDispositions);
  expect(logs.records).toEqual([]);
  expect(hitDispositions.snapshot()).toEqual({
    malformed: 2,
    excluded: 5,
    drift: 1,
  });
  reportCorpusHitDispositions({
    family: "case_law",
    counts: hitDispositions.snapshot(),
  });
  expect(logs.records).toEqual([
    expect.objectContaining({
      message: "corpus.search.hit_dispositions",
      severityText: "INFO",
      attributes: { family: "case_law", malformed: 2, excluded: 5, drift: 1 },
    }),
  ]);
});

test("valid hits retain their physical score and id order across every disposition mode", async () => {
  await assertProperty(
    "valid hits retain their physical score and id order across every disposition mode",
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }),
      async (validity) => {
        const hits = validity.map((valid, index) => ({
          document_id: valid ? `doc-${index}` : index,
          text: `passage-${index}`,
        }));
        for (const mode of modes) {
          stubHits(hits);
          const page = await readDispositionPage(mode);
          const expected = validity.flatMap((valid, index) =>
            valid
              ? [
                  {
                    id: `doc-${index}`,
                    score:
                      mode === "bm25"
                        ? ((validity.length - index) / validity.length) **
                          CORPUS_BM25_RATIO_POWER
                        : corpusIndexLexicalScore(index),
                  },
                ]
              : [],
          );
          expect(
            page.pageRanked.map(({ id, score }) => ({ id, score })),
          ).toEqual(expected);
        }
      },
    ),
  );
});
