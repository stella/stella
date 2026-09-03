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

/**
 * What the reader waits through is the number of sequential engine round
 * trips, so the scan is bounded twice: it stops as soon as no unseen
 * candidate can out-blend the page, and, failing that, at a fixed number of
 * rounds. The second bound is what a query whose lexical scores separate
 * slowly runs into.
 */
describe("the scan is bounded by engine round trips", () => {
  /** A bound no page score can fall below: the early stop never fires. */
  const readCappedPage = async (
    limit: number,
    parsedCursor: { score: number; id: string } | null = null,
  ) =>
    await readCorpusIndexSearchPage({
      cluster: "q08",
      indexId: "case_law_v2_cze",
      query: "text:smlouva",
      limit,
      parsedCursor,
      snippetFields: ["text"],
      extractId: (hit: CorpusIndexHit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: () => Number.POSITIVE_INFINITY,
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

  beforeEach(() => {
    // Far more hits than the round cap can reach, one passage each, so only
    // the cap can end the scan.
    engineHits = Array.from({ length: 5000 }, (_, index) => ({
      document_id: `doc-${String(index).padStart(4, "0")}`,
    }));
  });

  test("a scan whose stop condition never fires ends at the round cap", async () => {
    const page = await readCappedPage(10);

    expect(requestCount).toBe(LIMITS.corpusIndexSearchMaxRounds);
    expect(page.pageRanked).toHaveLength(10);
    // The page is still full and its own window holds more, so paging
    // continues within what the capped scan reached.
    expect(page.hasMore).toBe(true);
  });

  test("a capped scan advertises only what a rescan can reach again", async () => {
    const reachable =
      LIMITS.corpusIndexSearchMaxRounds *
      LIMITS.corpusIndexSearchCandidateLimit;

    const page = await readCappedPage(reachable);

    // Everything the cap allowed fits on one page, and a follow-up request
    // would spend the same rounds and see the same candidates, so there is
    // no next page to offer.
    expect(page.pageRanked).toHaveLength(reachable);
    expect(page.hasMore).toBe(false);
  });

  test("a cursor pages through what the capped scan reached", async () => {
    const first = await readCappedPage(10);
    const last = first.pageRanked.at(-1);
    if (last === undefined) {
      throw new Error("the first page must not be empty");
    }

    const second = await readCappedPage(10, { score: last.score, id: last.id });

    expect(requestCount).toBe(LIMITS.corpusIndexSearchMaxRounds * 2);
    expect(second.pageRanked.map((hit) => hit.id)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `doc-${String(index + 10).padStart(4, "0")}`,
      ),
    );
    const firstIds = new Set(first.pageRanked.map((hit) => hit.id));
    expect(second.pageRanked.some((hit) => firstIds.has(hit.id))).toBe(false);
  });

  test("a scan that can stop early spends one round", async () => {
    // The same hit list read through a bound that no unseen candidate can
    // beat: the page is answered from the first window.
    const page = await readPage(10);

    expect(requestCount).toBe(1);
    expect(page.pageRanked).toHaveLength(10);
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

/**
 * The ranker may fold several candidates into one hit (the language versions
 * of one judgment). The page must then hold `limit` folded hits, and a folded
 * member must never resurface as its own hit on a later page: the scan
 * replays the same order, so the same member represents the group each time.
 */
describe("ranker-folded candidates stay folded across pages", () => {
  const groupOf = (id: string): string | null =>
    id.startsWith("c-131-12-") ? "ECLI:EU:C:2014:317" : null;

  const readFoldedPage = async (
    limit: number,
    parsedCursor: { score: number; id: string } | null,
  ) =>
    await readCorpusIndexSearchPage({
      cluster: "q08",
      indexId: "case_law_v4_eu",
      query: "text:google",
      limit,
      parsedCursor,
      snippetFields: ["text"],
      extractId: (hit: CorpusIndexHit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: (score) => score,
      rankCandidates: async (candidates) => {
        const representativeByGroup = new Map<string, string>();
        const ranked = [];
        for (const candidate of candidates) {
          const group = groupOf(candidate.id);
          if (group !== null) {
            if (representativeByGroup.has(group)) {
              continue;
            }
            representativeByGroup.set(group, candidate.id);
          }
          ranked.push({
            id: candidate.id,
            score: candidate.score,
            lexicalScore: candidate.score,
            citationAuthority: 0,
          });
        }
        return { context: null, ranked };
      },
    });

  beforeEach(() => {
    // The judgment matched in 24 languages, interleaved with unrelated
    // decisions so the fold cannot rely on runs.
    const languages = Array.from({ length: 24 }, (_, i) => `l${i}`);
    engineHits = languages.flatMap((language, index) => [
      { document_id: `c-131-12-${language}` },
      { document_id: `other-${index}` },
    ]);
  });

  test("one judgment is one hit however many languages matched", async () => {
    const page = await readFoldedPage(3, null);

    expect(page.pageRanked.map((hit) => hit.id)).toEqual([
      "c-131-12-l0",
      "other-0",
      "other-1",
    ]);
    expect(page.hasMore).toBe(true);
  });

  test("no folded member resurfaces on later pages", async () => {
    const seen: string[] = [];
    let cursor: { score: number; id: string } | null = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page depends on the cursor the previous one emitted
      const page = await readFoldedPage(3, cursor);
      seen.push(...page.pageRanked.map((hit) => hit.id));
      const last = page.pageRanked.at(-1);
      if (!page.hasMore || last === undefined) {
        break;
      }
      cursor = { score: last.score, id: last.id };
    }

    expect(seen.filter((id) => groupOf(id) !== null)).toEqual(["c-131-12-l0"]);
    expect(seen.filter((id) => groupOf(id) === null)).toHaveLength(24);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
