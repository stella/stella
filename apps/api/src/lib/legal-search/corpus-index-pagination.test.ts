import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import { LIMITS } from "@/api/lib/limits";

/**
 * Grouping passage hits back into document hits. A passage-granular generation
 * returns one hit per matching passage, but the API's unit is the document:
 * the page, the cursor, and the rerank all key on `document_id`. These tests
 * stub the engine's HTTP response and assert the collapse — which document
 * wins, which passage supplies its snippet and anchor, and that a
 * document-granular response still behaves exactly as before.
 */

const originalFetch = globalThis.fetch;
let responseBody: unknown;
/**
 * Whole hit list the fake engine holds. When set, the stub honours
 * `start_offset`/`max_hits` so a scan that needs several windows behaves the
 * way it would against the real engine; `responseBody` stays available for the
 * single-window cases.
 */
let engineHits: { document_id: string; anchor_id?: string }[] | null;
let requestCount: number;

beforeEach(() => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  engineHits = null;
  requestCount = 0;
  const stub = async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    requestCount += 1;
    if (engineHits === null) {
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }
    const body: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const offset = Number(body["start_offset"] ?? 0);
    const window = engineHits.slice(offset, offset + Number(body["max_hits"]));
    return new Response(
      JSON.stringify({
        num_hits: engineHits.length,
        hits: window,
        snippets: window.map((hit) => ({ text: [`snip ${hit.document_id}`] })),
      }),
      { status: 200 },
    );
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const readPage = async (limit = 10) =>
  await readCorpusIndexSearchPage({
    cluster: "q08",
    indexId: "case_law_v2_cze",
    query: "text:promlčení",
    limit,
    parsedCursor: null,
    snippetFields: ["text"],
    extractId: (hit: CorpusIndexHit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: (snippet) => {
      const text = snippet?.["text"];
      return Array.isArray(text) ? String(text.at(0)) : null;
    },
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (candidates) => ({
      context: null,
      ranked: candidates.map((candidate) => ({
        id: candidate.id,
        score: candidate.score,
        lexicalScore: candidate.score,
        citationAuthority: 0,
      })),
    }),
  });

describe("passage hits group into document hits", () => {
  beforeEach(() => {
    // Engine order: doc-b's best passage outscores every doc-a passage.
    const hits = [
      { document_id: "doc-b", seq: 7, anchor_id: "b-p7" },
      { document_id: "doc-a", seq: 2, anchor_id: "a-p2" },
      { document_id: "doc-a", seq: 9, anchor_id: "a-p9" },
      { document_id: "doc-b", seq: 1, anchor_id: "b-p1" },
      { document_id: "doc-a", seq: 4, anchor_id: "a-p4" },
    ];
    responseBody = {
      num_hits: hits.length,
      hits,
      snippets: hits.map((hit) => ({
        text: [`passage ${hit.document_id}:${hit.seq}`],
      })),
    };
  });

  test("a document appears once, ranked by its best passage", async () => {
    const page = await readPage();

    expect(page.pageRanked.map((hit) => hit.id)).toEqual(["doc-b", "doc-a"]);
    // doc-a matched three passages but must not occupy three result slots.
    expect(page.pageRanked).toHaveLength(2);
  });

  test("the snippet and the anchor come from the best passage, not the last", async () => {
    const page = await readPage();

    expect(page.snippetById.get("doc-a")).toBe("passage doc-a:2");
    expect(page.anchorIdById.get("doc-a")).toBe("a-p2");
    expect(page.snippetById.get("doc-b")).toBe("passage doc-b:7");
    expect(page.anchorIdById.get("doc-b")).toBe("b-p7");
  });

  test("matching passages are counted per document", async () => {
    const page = await readPage();

    expect(page.passageCountById.get("doc-a")).toBe(3);
    expect(page.passageCountById.get("doc-b")).toBe(2);
  });

  test("the passage count does not change a document's score", async () => {
    const page = await readPage();

    // Breadth is reported, never blended in: an emitted hit's score has to
    // survive the next scan window unchanged or the keyset cursor drifts, and
    // the count only grows as the scan widens.
    const [best, second] = page.pageRanked;
    expect(best?.score).toBeGreaterThan(second?.score ?? 0);
    expect(best?.id).toBe("doc-b");
  });
});

describe("document-granular responses are unaffected", () => {
  test("one hit per document yields one passage each and no anchors", async () => {
    const hits = [{ document_id: "doc-a" }, { document_id: "doc-b" }];
    responseBody = {
      num_hits: hits.length,
      hits,
      snippets: hits.map((hit) => ({ text: [`whole ${hit.document_id}`] })),
    };

    const page = await readPage();

    expect(page.pageRanked.map((hit) => hit.id)).toEqual(["doc-a", "doc-b"]);
    expect(page.passageCountById.get("doc-a")).toBe(1);
    // Nothing to deep-link to when the whole document is the unit.
    expect(page.anchorIdById.size).toBe(0);
    expect(page.snippetById.get("doc-a")).toBe("whole doc-a");
  });
});

describe("a single document cannot monopolise the scan", () => {
  /**
   * Two query shapes produce the same hazard, and both are now closed at
   * indexing time — `title` is written to the opening passage only, and
   * `heading_path` is not a default search field. The read path still has to
   * survive the shape, because body text can legitimately match many passages
   * of one long decision, so it is exercised here for each.
   */
  const expectFloodYieldsToOthers = async (floodSize: number) => {
    const flood = Array.from({ length: floodSize }, (_, seq) => ({
      document_id: "doc-flood",
      anchor_id: `flood-p${seq}`,
    }));
    const others = Array.from({ length: 40 }, (_, index) => ({
      document_id: `doc-${index}`,
      anchor_id: `other-${index}`,
    }));
    engineHits = [...flood, ...others];

    const page = await readPage(5);

    // The flooding document takes one slot, not the page.
    expect(page.pageRanked.at(0)?.id).toBe("doc-flood");
    expect(
      page.pageRanked.filter((hit) => hit.id === "doc-flood"),
    ).toHaveLength(1);
    expect(page.pageRanked).toHaveLength(5);
    expect(new Set(page.pageRanked.map((hit) => hit.id)).size).toBe(5);
    // Only a flood that overruns one window proves the scan kept walking to
    // reach the other decisions; a smaller one is served in a single request.
    if (floodSize > LIMITS.corpusIndexSearchCandidateLimit) {
      expect(requestCount).toBeGreaterThan(1);
    }
    expect(page.passageCountById.get("doc-flood")).toBe(floodSize);
    for (const hit of page.pageRanked.slice(1)) {
      expect(page.passageCountById.get(hit.id)).toBe(1);
    }
  };

  test("a court-name query matching a document-level title", async () => {
    // Every passage of one long judgment carrying the same title: what the
    // index produced before `title` moved to the opening passage.
    await expectFloodYieldsToOthers(400);
  });

  test("a query matching a boilerplate section heading", async () => {
    // Every continuation passage of one section carrying the same
    // `heading_path`: what a free-text term reached before the field left
    // `default_search_fields`.
    await expectFloodYieldsToOthers(250);
  });
});

describe("document paging survives the passage fan-out", () => {
  test("a page holds `limit` documents even when each matched several passages", async () => {
    const documentIds = Array.from({ length: 8 }, (_, i) => `doc-${i}`);
    // Interleaved so no document's passages are contiguous: grouping cannot
    // rely on runs.
    const hits = [0, 1, 2].flatMap((passage) =>
      documentIds.map((documentId) => ({
        document_id: documentId,
        anchor_id: `${documentId}-p${passage}`,
      })),
    );
    responseBody = {
      num_hits: hits.length,
      hits,
      snippets: hits.map(() => ({ text: ["x"] })),
    };

    const page = await readPage(3);

    expect(page.pageRanked).toHaveLength(3);
    expect(new Set(page.pageRanked.map((hit) => hit.id)).size).toBe(3);
    // Every document kept its first (best) passage's anchor.
    for (const hit of page.pageRanked) {
      expect(page.anchorIdById.get(hit.id)).toBe(`${hit.id}-p0`);
      expect(page.passageCountById.get(hit.id)).toBe(3);
    }
    expect(page.hasMore).toBe(true);
  });
});
