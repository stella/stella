import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  corpusIndexLexicalScore,
  decodeCorpusIndexCursor,
  encodeCorpusIndexCursor,
  HIGHLIGHT_COPIES_PER_PASSAGE,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  blendStableCitationAuthority,
  DEFAULT_AUTHORITY_WEIGHT,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
import { encodeCursor } from "@/api/lib/search/cursor";

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
let engineHits:
  | { document_id: string; anchor_id?: string; chunk_id?: string }[]
  | null;
let requestBodies: Record<string, unknown>[];
/**
 * Wall time the fake engine spends on every request. Zero by default, so only
 * the test that reads `indexMs` pays for it; that test needs the number to be
 * made of something it can predict a floor for.
 */
let requestDelayMs: number;
/**
 * What the fake engine answers the highlight round with, when that has to
 * differ from what the scan saw — a passage the index holds more than one
 * physical copy of, say.
 */
let snippetResponseBody: unknown;

beforeEach(() => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  engineHits = null;
  requestBodies = [];
  requestDelayMs = 0;
  snippetResponseBody = null;
  const stub = async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const body: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    requestBodies.push(body);
    if (requestDelayMs > 0) {
      await Bun.sleep(requestDelayMs);
    }
    if (snippetResponseBody !== null && body["snippet_fields"] !== undefined) {
      return new Response(JSON.stringify(snippetResponseBody), { status: 200 });
    }
    if (engineHits === null) {
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }
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

/**
 * Engine calls the scan itself made. The page's snippet round is the one
 * request that asks for highlighting, so the scan's own rounds are everything
 * else.
 */
const scanRequestCount = (): number =>
  requestBodies.filter((body) => body["snippet_fields"] === undefined).length;

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
      expect(scanRequestCount()).toBeGreaterThan(1);
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
 * The rank-derived lexical score decays by a factor of e per round of
 * candidates, which is what lets a page settle inside the first round: the
 * blend's whole additive weight cannot carry a hit from the next round past
 * the page's last hit. These tests run the real blend and the real bound, and
 * grant no authority to anything, which is the worst case — the page's cursor
 * score gets nothing from authority while the bound assumes an unseen hit
 * takes all of it.
 */
describe("a page settles within one scan round", () => {
  const readBlendedPage = async (
    limit: number,
    weight: number,
    parsedCursor: SearchCursor | null = null,
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
      unseenScoreUpperBound: (score) => stableBlendUpperBound(score, weight),
      rankCandidates: async (candidates) => ({
        context: null,
        ranked: blendStableCitationAuthority({
          candidates,
          authorityById: new Map(),
          weight,
        }),
      }),
    });

  const documentId = (index: number) => `doc-${String(index).padStart(5, "0")}`;

  beforeEach(() => {
    engineHits = Array.from({ length: 30_000 }, (_, index) => ({
      document_id: documentId(index),
    }));
  });

  test("a page of a very large hit list is answered from one round", async () => {
    const page = await readBlendedPage(20, DEFAULT_AUTHORITY_WEIGHT);

    expect(scanRequestCount()).toBe(1);
    expect(page.scan.rounds).toBe(1);
    expect(page.scan.earlyStopped).toBe(true);
    expect(page.pageRanked).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
  });

  test("the largest page the API serves still settles in one round", async () => {
    const page = await readBlendedPage(
      LIMITS.caseLawSearchPageSizeMax,
      DEFAULT_AUTHORITY_WEIGHT,
    );

    expect(scanRequestCount()).toBe(1);
    expect(page.scan.earlyStopped).toBe(true);
  });

  test("a wider additive weight still settles in one round", async () => {
    // Headroom for a second additive signal: the bound widens to the sum of
    // the weights, and the decay has to outrun the sum, not one term of it.
    const combinedWeight = 0.5;
    expect(
      stableBlendUpperBound(corpusIndexLexicalScore(300), combinedWeight),
    ).toBeLessThan(corpusIndexLexicalScore(19));

    const page = await readBlendedPage(20, combinedWeight);

    expect(scanRequestCount()).toBe(1);
    expect(page.scan.earlyStopped).toBe(true);
  });

  test("a cursor continues the same scores without repeating a hit", async () => {
    const first = await readBlendedPage(20, DEFAULT_AUTHORITY_WEIGHT);
    const last = first.pageRanked.at(-1);
    if (last === undefined) {
      throw new Error("the first page must not be empty");
    }
    // The cursor encodes the score the rank alone produces, so the rescan
    // behind page two assigns the emitted hits exactly the same values.
    expect(last.score).toBe(corpusIndexLexicalScore(19));

    const second = await readBlendedPage(
      20,
      DEFAULT_AUTHORITY_WEIGHT,
      first.nextCursor,
    );

    expect(second.pageRanked.at(0)?.id).toBe(documentId(20));
    expect(second.pageRanked.at(0)?.score).toBe(corpusIndexLexicalScore(20));
    expect(second.pageRanked).toHaveLength(20);
    const firstIds = new Set(first.pageRanked.map((hit) => hit.id));
    expect(second.pageRanked.some((hit) => firstIds.has(hit.id))).toBe(false);
  });

  test("a hit's score reads its rank and nothing about the hit count", async () => {
    const large = await readBlendedPage(20, DEFAULT_AUTHORITY_WEIGHT);
    engineHits = Array.from({ length: 1000 }, (_, index) => ({
      document_id: documentId(index),
    }));

    const small = await readBlendedPage(20, DEFAULT_AUTHORITY_WEIGHT);

    // The same ranks in a hit list thirty times smaller: an emitted score no
    // longer moves when the corpus grows under a reader holding a cursor.
    expect(small.pageRanked.map((hit) => hit.score)).toEqual(
      large.pageRanked.map((hit) => hit.score),
    );
    expect(corpusIndexLexicalScore(0)).toBe(1);
    expect(corpusIndexLexicalScore(1)).toBeLessThan(corpusIndexLexicalScore(0));
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
  const documentId = (index: number) => `doc-${String(index).padStart(4, "0")}`;

  /** A bound no page score can fall below: the early stop never fires. */
  const readCappedPage = async (
    limit: number,
    parsedCursor: SearchCursor | null = null,
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
      unseenScoreUpperBound: (score) => score + 1,
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
      document_id: documentId(index),
    }));
  });

  test("a scan whose stop condition never fires ends at the round cap", async () => {
    const page = await readCappedPage(10);

    expect(scanRequestCount()).toBe(LIMITS.corpusIndexSearchMaxRounds);
    expect(page.pageRanked).toHaveLength(10);
    // The page is still full and its own window holds more, so paging
    // continues within what the capped scan reached.
    expect(page.nextCursor).not.toBeNull();
    expect(page.scan.rounds).toBe(LIMITS.corpusIndexSearchMaxRounds);
    expect(page.scan.passagesScanned).toBe(
      LIMITS.corpusIndexSearchMaxRounds *
        LIMITS.corpusIndexSearchCandidateLimit,
    );
    expect(page.scan.roundCapHit).toBe(true);
    expect(page.scan.earlyStopped).toBe(false);
    expect(page.scan.indexMs).toBeGreaterThanOrEqual(0);
  });

  test("a capped scan whose window is exhausted opens the next one", async () => {
    const reachable =
      LIMITS.corpusIndexSearchMaxRounds *
      LIMITS.corpusIndexSearchCandidateLimit;

    const page = await readCappedPage(reachable);

    // Everything the cap allowed fits on one page, so replaying this window
    // would return the same hits; the reader continues in the next one.
    expect(page.pageRanked).toHaveLength(reachable);
    expect(page.nextCursor?.windowStart).toBe(reachable);
  });

  test("a scan that reached the end of the hit list offers no next window", async () => {
    engineHits = Array.from({ length: 40 }, (_, index) => ({
      document_id: documentId(index),
    }));

    const page = await readCappedPage(40);

    expect(page.scan.roundCapHit).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  test("a cursor pages through what the capped scan reached", async () => {
    const first = await readCappedPage(10);
    const last = first.pageRanked.at(-1);
    if (last === undefined) {
      throw new Error("the first page must not be empty");
    }

    const second = await readCappedPage(10, first.nextCursor);

    expect(scanRequestCount()).toBe(LIMITS.corpusIndexSearchMaxRounds * 2);
    expect(second.pageRanked.map((hit) => hit.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => documentId(index + 10)),
    );
    const firstIds = new Set(first.pageRanked.map((hit) => hit.id));
    expect(second.pageRanked.some((hit) => firstIds.has(hit.id))).toBe(false);
  });

  test("a scan that can stop early spends one round", async () => {
    // The same hit list read through a bound that no unseen candidate can
    // beat: the page is answered from the first window.
    const page = await readPage(10);

    expect(scanRequestCount()).toBe(1);
    expect(page.pageRanked).toHaveLength(10);
    expect(page.scan.rounds).toBe(1);
    expect(page.scan.passagesScanned).toBe(
      LIMITS.corpusIndexSearchCandidateLimit,
    );
    expect(page.scan.earlyStopped).toBe(true);
    expect(page.scan.roundCapHit).toBe(false);
  });
});

/**
 * A decision long enough to fill the whole capped window with its own
 * passages. Nothing bounds passages per document anywhere near the scan
 * budget — the chunker's ceiling is a hostile-input bound orders of magnitude
 * higher — so the page cannot be made whole by sizing the cap. It is made
 * whole by moving the window instead.
 */
describe("a passage flood does not strand the reader", () => {
  const documentId = (index: number) => `doc-${String(index).padStart(4, "0")}`;
  const floodSize = 1000;

  const readFloodPage = async (
    limit: number,
    parsedCursor: SearchCursor | null = null,
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
      unseenScoreUpperBound: (score) =>
        stableBlendUpperBound(score, DEFAULT_AUTHORITY_WEIGHT),
      rankCandidates: async (candidates) => ({
        context: null,
        ranked: blendStableCitationAuthority({
          candidates,
          authorityById: new Map(),
          weight: DEFAULT_AUTHORITY_WEIGHT,
        }),
      }),
    });

  beforeEach(() => {
    // One decision's passages fill more than the cap can scan, then ordinary
    // decisions follow.
    engineHits = [
      ...Array.from({ length: floodSize }, (_, seq) => ({
        document_id: "doc-flood",
        anchor_id: `flood-p${seq}`,
      })),
      ...Array.from({ length: 60 }, (_, index) => ({
        document_id: documentId(index),
      })),
    ];
  });

  test("the flooded page still offers a way forward", async () => {
    const page = await readFloodPage(10);

    // The capped window held one decision, so the page is one hit — but the
    // reader is not stranded on it.
    expect(page.pageRanked.map((hit) => hit.id)).toEqual(["doc-flood"]);
    expect(page.scan.roundCapHit).toBe(true);
    expect(page.nextCursor?.windowStart).toBe(
      LIMITS.corpusIndexSearchMaxRounds *
        LIMITS.corpusIndexSearchCandidateLimit,
    );
  });

  test("the next page continues past the flood without rescanning it", async () => {
    const first = await readFloodPage(10);
    requestBodies = [];

    const second = await readFloodPage(10, first.nextCursor);

    // Every round of page two reads past where page one stopped, and the
    // decision that filled page one does not come back.
    expect(second.pageRanked.map((hit) => hit.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => documentId(index)),
    );
    expect(second.scan.passagesScanned).toBeLessThanOrEqual(
      LIMITS.corpusIndexSearchMaxRounds *
        LIMITS.corpusIndexSearchCandidateLimit,
    );
    expect(scanRequestCount()).toBeLessThanOrEqual(
      LIMITS.corpusIndexSearchMaxRounds,
    );
  });

  test("paging reaches every decision behind the flood", async () => {
    const seen: string[] = [];
    let cursor: SearchCursor | null = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page depends on the cursor the previous one emitted
      const page = await readFloodPage(10, cursor);
      seen.push(...page.pageRanked.map((hit) => hit.id));
      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("doc-flood");
    expect(seen).toContain(documentId(59));
  });
});

describe("the cursor survives its wire form", () => {
  test("a window cursor round-trips", () => {
    const cursor = {
      score: 0.5,
      id: "4a1b6f6e-0e5a-4a51-9e9f-1a2b3c4d5e6f",
      windowStart: 900,
    };

    expect(decodeCorpusIndexCursor(encodeCorpusIndexCursor(cursor))).toEqual(
      cursor,
    );
  });

  test("a payload without a window names the first one", () => {
    // What a cursor issued before windows existed decodes to, and what a
    // caller that builds the payload by hand gets.
    const legacy = encodeCursor(0.5, "4a1b6f6e-0e5a-4a51-9e9f-1a2b3c4d5e6f");

    expect(decodeCorpusIndexCursor(legacy)).toEqual({
      score: 0.5,
      id: "4a1b6f6e-0e5a-4a51-9e9f-1a2b3c4d5e6f",
      windowStart: 0,
    });
  });

  test("a malformed window is rejected rather than guessed", () => {
    expect(decodeCorpusIndexCursor(encodeCursor(0.5, "-3:abc"))).toBeNull();
    expect(decodeCorpusIndexCursor(encodeCursor(0.5, "12:"))).toBeNull();
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
    expect(page.nextCursor).not.toBeNull();
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
    parsedCursor: SearchCursor | null,
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
    expect(page.nextCursor).not.toBeNull();
  });

  test("no folded member resurfaces on later pages", async () => {
    const seen: string[] = [];
    let cursor: SearchCursor | null = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page depends on the cursor the previous one emitted
      const page = await readFoldedPage(3, cursor);
      seen.push(...page.pageRanked.map((hit) => hit.id));
      const last = page.pageRanked.at(-1);
      if (page.nextCursor === null || last === undefined) {
        break;
      }
      cursor = page.nextCursor;
    }

    expect(seen.filter((id) => groupOf(id) !== null)).toEqual(["c-131-12-l0"]);
    expect(seen.filter((id) => groupOf(id) === null)).toHaveLength(24);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

/**
 * Highlighting is per-hit work the engine does, so a scan that asked for it
 * highlighted every passage it walked — a few hundred of them — to serve a
 * page of ten. The page decides which passages are worth highlighting, so the
 * snippets are cut after it, in one request addressing exactly those passages.
 */
describe("only the passages a page emits are highlighted", () => {
  const snippetRequests = (): Record<string, unknown>[] =>
    requestBodies.filter((body) => body["snippet_fields"] !== undefined);

  test("the scan asks for no highlighting and the page round asks for it once", async () => {
    engineHits = Array.from({ length: 5000 }, (_, index) => ({
      chunk_id: `doc-${index}:0`,
      document_id: `doc-${index}`,
    }));

    const page = await readPage(3);

    expect(scanRequestCount()).toBeGreaterThan(0);
    expect(snippetRequests()).toHaveLength(1);
    expect(page.scan.highlightRounds).toBe(1);
    const snippetRequest = snippetRequests().at(0);
    expect(snippetRequest?.["snippet_fields"]).toBe("text");
    // One passage per emitted hit, with room for the physical copies a
    // passage mid-refresh has: bounded by the page, not by the scan.
    expect(snippetRequest?.["max_hits"]).toBe(3 * HIGHLIGHT_COPIES_PER_PASSAGE);
    expect(snippetRequest?.["query"]).toBe(
      '(text:promlčení) AND (chunk_id:"doc-0:0" OR chunk_id:"doc-1:0" OR chunk_id:"doc-2:0")',
    );
  });

  test("a document-granular generation is addressed by document", async () => {
    const hits = [{ document_id: "doc-a" }, { document_id: "doc-b" }];
    responseBody = {
      num_hits: hits.length,
      hits,
      snippets: hits.map((hit) => ({ text: [`whole ${hit.document_id}`] })),
    };

    const page = await readPage();

    expect(snippetRequests().at(0)?.["query"]).toBe(
      '(text:promlčení) AND (document_id:"doc-a" OR document_id:"doc-b")',
    );
    expect(page.snippetById.get("doc-a")).toBe("whole doc-a");
  });

  test("the highlighted passage is the one the document ranked by", async () => {
    const hits = [
      { document_id: "doc-b", chunk_id: "doc-b:7" },
      { document_id: "doc-a", chunk_id: "doc-a:2" },
      { document_id: "doc-a", chunk_id: "doc-a:9" },
    ];
    responseBody = {
      num_hits: hits.length,
      hits,
      snippets: hits.map((hit) => ({ text: [`passage ${hit.chunk_id}`] })),
    };

    const page = await readPage();

    // doc-a matched three passages; only its best is worth highlighting, and
    // it is the same passage the anchor deep-links to.
    expect(snippetRequests().at(0)?.["query"]).toBe(
      '(text:promlčení) AND (chunk_id:"doc-b:7" OR chunk_id:"doc-a:2")',
    );
    expect(page.snippetById.get("doc-a")).toBe("passage doc-a:2");
  });

  test("an empty page asks the engine for nothing to highlight", async () => {
    responseBody = { num_hits: 0, hits: [] };

    const page = await readPage();

    expect(page.pageRanked).toEqual([]);
    expect(page.snippetById.size).toBe(0);
    expect(snippetRequests()).toEqual([]);
    expect(page.scan.highlightRounds).toBe(0);
  });

  test("a passage the index holds twice does not cost another hit its snippet", async () => {
    // Mid-refresh: ingestion has appended doc-a's new copy and the engine has
    // not applied the delete yet, so one clause matches two rows.
    const scanned = [
      { document_id: "doc-a", chunk_id: "doc-a:0" },
      { document_id: "doc-b", chunk_id: "doc-b:0" },
      { document_id: "doc-c", chunk_id: "doc-c:0" },
    ];
    responseBody = {
      num_hits: scanned.length,
      hits: scanned,
      snippets: scanned.map(() => ({ text: ["scanned"] })),
    };
    const highlighted = [
      { document_id: "doc-a", chunk_id: "doc-a:0" },
      { document_id: "doc-a", chunk_id: "doc-a:0" },
      { document_id: "doc-b", chunk_id: "doc-b:0" },
      { document_id: "doc-c", chunk_id: "doc-c:0" },
    ];
    snippetResponseBody = {
      num_hits: highlighted.length,
      hits: highlighted,
      snippets: [
        { text: ["doc-a current"] },
        { text: ["doc-a superseded"] },
        { text: ["doc-b"] },
        { text: ["doc-c"] },
      ],
    };

    const page = await readPage();

    // Room for the overlap, so the duplicate does not push doc-c out of the
    // answer, and the copy that ranked first is the one the reader sees.
    expect(snippetRequests().at(0)?.["max_hits"]).toBe(
      3 * HIGHLIGHT_COPIES_PER_PASSAGE,
    );
    expect(page.snippetById.get("doc-a")).toBe("doc-a current");
    expect(page.snippetById.get("doc-b")).toBe("doc-b");
    expect(page.snippetById.get("doc-c")).toBe("doc-c");
    for (const hit of page.pageRanked) {
      expect(page.snippetById.get(hit.id)).toBeDefined();
    }
  });
});

/**
 * `indexMs` is the engine half of a search's latency, and a page now spends it
 * in two places: the scan's rounds and the one round that highlights the page.
 * The two counts are what reconcile the total, so a round trip that stopped
 * being counted — or a duration that stopped being added — has to fail here
 * rather than surface as engine time nobody can attribute.
 */
describe("the reported engine time accounts for every round trip", () => {
  /** Long enough that the floors below cannot be met by scheduling noise. */
  const DELAY_MS = 20;

  test("every engine request is one of the counted rounds", async () => {
    engineHits = Array.from({ length: 5000 }, (_, index) => ({
      chunk_id: `doc-${index}:0`,
      document_id: `doc-${index}`,
    }));

    const page = await readPage(3);

    expect(page.scan.rounds).toBeGreaterThan(0);
    expect(page.scan.highlightRounds).toBe(1);
    expect(requestBodies).toHaveLength(
      page.scan.rounds + page.scan.highlightRounds,
    );
  });

  test("the total covers the highlight round, not the scan alone", async () => {
    requestDelayMs = DELAY_MS;
    engineHits = Array.from({ length: 5000 }, (_, index) => ({
      chunk_id: `doc-${index}:0`,
      document_id: `doc-${index}`,
    }));

    const startedAt = performance.now();
    const page = await readPage(3);
    const elapsedMs = performance.now() - startedAt;

    // One round of scanning plus one of highlighting, each of which the fake
    // engine held open for a known minimum: a total that dropped either would
    // fall under this floor. The read's own elapsed time is the ceiling —
    // engine time is time the read spent, so a duration counted twice would
    // cross it.
    expect(page.scan.rounds).toBe(1);
    expect(page.scan.highlightRounds).toBe(1);
    expect(page.scan.indexMs).toBeGreaterThanOrEqual(2 * DELAY_MS);
    expect(page.scan.indexMs).toBeLessThanOrEqual(elapsedMs);
  });

  test("a page that highlights nothing is charged for the scan only", async () => {
    requestDelayMs = DELAY_MS;
    responseBody = { num_hits: 0, hits: [] };

    const startedAt = performance.now();
    const page = await readPage();
    const elapsedMs = performance.now() - startedAt;

    expect(page.scan.rounds).toBe(1);
    expect(page.scan.highlightRounds).toBe(0);
    expect(requestBodies).toHaveLength(1);
    expect(page.scan.indexMs).toBeGreaterThanOrEqual(DELAY_MS);
    expect(page.scan.indexMs).toBeLessThanOrEqual(elapsedMs);
  });
});
