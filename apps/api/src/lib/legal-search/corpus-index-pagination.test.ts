import { panic, Panic } from "better-result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import fc from "fast-check";

import { SEARCH_PAGE_REACH } from "@stll/api-contract/search";
import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { withPinnedDecisions } from "@/api/handlers/case-law/decisions/search-identity-role";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  CORPUS_INDEX_SEARCH_TIMEOUT_MS,
  type CorpusIndexHit,
} from "@/api/lib/legal-search/corpus-index-client";
import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  corpusIndexLexicalScore,
  CORPUS_INDEX_OFFSET_PAGE_MAX_ROUNDS,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
import {
  type CorpusSearchOrder,
  RELEVANCE_ORDER,
} from "@/api/lib/legal-search/corpus-search-order";
import { collapseByLanguageGroup } from "@/api/lib/legal-search/language-group-collapse";
import { collapseLegislationHitsByWork } from "@/api/lib/legal-search/legislation-work-collapse";
import {
  blendStableCitationAuthority,
  DEFAULT_AUTHORITY_WEIGHT,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
import {
  testRevisionOf,
  testRevisionsFor,
} from "@/api/tests/helpers/corpus-projection-revisions";

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
/**
 * Status the fake engine answers every request with, when the test is about
 * what a refusal does rather than what a result does.
 */
let engineFailureStatus: number | null;
let highlightInFlight: number;
let peakHighlightInFlight: number;

beforeEach(() => {
  responseBody = { num_hits: 0, hits: [], snippets: [] };
  engineHits = null;
  requestBodies = [];
  requestDelayMs = 0;
  snippetResponseBody = null;
  engineFailureStatus = null;
  highlightInFlight = 0;
  peakHighlightInFlight = 0;
  const stub = async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const body: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    requestBodies.push(body);
    const highlighting = body["snippet_fields"] !== undefined;
    if (highlighting) {
      highlightInFlight += 1;
      peakHighlightInFlight = Math.max(
        peakHighlightInFlight,
        highlightInFlight,
      );
    }
    if (requestDelayMs > 0) {
      await Bun.sleep(requestDelayMs);
    }
    if (highlighting) {
      highlightInFlight -= 1;
    }
    if (engineFailureStatus !== null) {
      return new Response("engine refused the search", {
        status: engineFailureStatus,
      });
    }
    if (snippetResponseBody !== null && body["snippet_fields"] !== undefined) {
      return new Response(JSON.stringify(snippetResponseBody), { status: 200 });
    }
    if (engineHits === null) {
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }
    const offset = Number(body["start_offset"] ?? 0);
    const matching =
      body["snippet_fields"] === undefined
        ? engineHits
        : engineHits.filter(
            (hit) =>
              String(body["query"]).includes(
                `document_id:"${hit.document_id}"`,
              ) ||
              (typeof hit.chunk_id === "string" &&
                String(body["query"]).includes(`chunk_id:"${hit.chunk_id}"`)),
          );
    const window = matching.slice(offset, offset + Number(body["max_hits"]));
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
  mock.restore();
});

/**
 * Engine calls the scan itself made. The page's snippet round is the one
 * request that asks for highlighting, so the scan's own rounds are everything
 * else.
 */
const scanRequestCount = (): number =>
  requestBodies.filter((body) => body["snippet_fields"] === undefined).length;

const recurringFixtureIdentities = (
  identityOf: (id: string) => string = (id) => id,
) => {
  const seen = new Set<string>();
  const recurring = new Set<string>();
  for (const hit of engineHits ?? []) {
    const identity = identityOf(hit.document_id);
    if (seen.has(identity)) {
      recurring.add(identity);
    }
    seen.add(identity);
  }
  return recurring;
};

const recurringDocumentTokens = (candidates: readonly { id: string }[]) => {
  const recurring = recurringFixtureIdentities();
  return candidates
    .filter(({ id }) => recurring.has(id))
    .map(({ id }) => corpusSearchGroupToken(id));
};

const readPage = async (
  limit = 10,
  parsedCursor: SearchCursor | null = null,
  order: CorpusSearchOrder = RELEVANCE_ORDER,
) =>
  await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "case_law_v5_cs_sk",
    query: "text:promlčení",
    limit,
    order,
    parsedCursor,
    snippetFields: ["text"],
    projectionRevisionField: "projection_revision",
    extractId: (hit: CorpusIndexHit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: (snippet) => {
      const text = snippet?.["text"];
      return Array.isArray(text) ? String(text.at(0)) : null;
    },
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (candidates) => ({
      context: null,
      revisionById: testRevisionsFor(candidates),
      groups: recurringDocumentTokens(candidates),
      ranked: candidates
        .filter(
          (candidate) =>
            !parsedCursor?.excludedGroups?.includes(
              corpusSearchGroupToken(candidate.id),
            ),
        )
        .map((candidate) => ({
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
      observer: "unobserved",
      cluster: "q09",
      indexId: "case_law_v5_cs_sk",
      query: "text:smlouva",
      limit,
      order: RELEVANCE_ORDER,
      parsedCursor,
      snippetFields: ["text"],
      projectionRevisionField: "projection_revision",
      extractId: (hit: CorpusIndexHit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: (score) => stableBlendUpperBound(score, weight),
      rankCandidates: async (candidates) => ({
        context: null,
        revisionById: testRevisionsFor(candidates),
        groups: recurringDocumentTokens(candidates),
        ranked: blendStableCitationAuthority({
          candidates: candidates.filter(
            (candidate) =>
              !parsedCursor?.excludedGroups?.includes(
                corpusSearchGroupToken(candidate.id),
              ),
          ),
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
      observer: "unobserved",
      cluster: "q09",
      indexId: "case_law_v5_cs_sk",
      query: "text:smlouva",
      limit,
      order: RELEVANCE_ORDER,
      parsedCursor,
      snippetFields: ["text"],
      projectionRevisionField: "projection_revision",
      extractId: (hit: CorpusIndexHit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: (score) => score + 1,
      rankCandidates: async (candidates) => ({
        context: null,
        revisionById: testRevisionsFor(candidates),
        groups: recurringDocumentTokens(candidates),
        ranked: candidates
          .filter(
            (candidate) =>
              !parsedCursor?.excludedGroups?.includes(
                corpusSearchGroupToken(candidate.id),
              ),
          )
          .map((candidate) => ({
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

  test("singleton documents exceeding the exclusion budget retain continuation", async () => {
    const reachable =
      LIMITS.corpusIndexSearchMaxRounds *
      LIMITS.corpusIndexSearchCandidateLimit;

    const page = await readCappedPage(reachable);

    // Single-passage documents cannot recur beyond this window.
    expect(reachable).toBeGreaterThan(
      LIMITS.corpusIndexSearchMaxExcludedGroups,
    );
    expect(page.pageRanked).toHaveLength(reachable);
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor?.excludedGroups).toBeUndefined();
  });

  test.each([37, 200, 300])(
    "single-passage documents walk every window without loss or duplicates at limit %i",
    async (limit) => {
      engineHits = Array.from({ length: 1001 }, (_, index) => ({
        document_id: documentId(index),
      }));
      expect(engineHits.length).toBeGreaterThan(
        LIMITS.corpusIndexSearchMaxExcludedGroups,
      );
      const expectedIds = engineHits.map(({ document_id }) => document_id);
      const seen: string[] = [];
      const windows = new Set<number>();
      let cursor: SearchCursor | null = null;
      for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
        const page = await readCappedPage(limit, cursor);
        seen.push(...page.pageRanked.map(({ id }) => id));
        cursor = page.nextCursor;
        if (cursor === null) {
          break;
        }
        windows.add(cursor.windowStart);
        expect(cursor.excludedGroups).toBeUndefined();
      }
      expect(cursor).toBeNull();
      expect(windows.size).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expectedIds);
    },
  );

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
      observer: "unobserved",
      cluster: "q09",
      indexId: "case_law_v5_cs_sk",
      query: "text:smlouva",
      limit,
      order: RELEVANCE_ORDER,
      parsedCursor,
      snippetFields: ["text"],
      projectionRevisionField: "projection_revision",
      extractId: (hit: CorpusIndexHit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: (score) =>
        stableBlendUpperBound(score, DEFAULT_AUTHORITY_WEIGHT),
      rankCandidates: async (candidates) => ({
        context: null,
        revisionById: testRevisionsFor(candidates),
        groups: recurringDocumentTokens(candidates),
        ranked: blendStableCitationAuthority({
          candidates: candidates.filter(
            (candidate) =>
              !parsedCursor?.excludedGroups?.includes(
                corpusSearchGroupToken(candidate.id),
              ),
          ),
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

describe("residual filters preserve progress past empty scan windows", () => {
  const reachable =
    LIMITS.corpusIndexSearchMaxRounds * LIMITS.corpusIndexSearchCandidateLimit;
  const readFilteredPage = async (
    parsedCursor: SearchCursor | null,
    order: CorpusSearchOrder,
  ) =>
    await readCorpusIndexSearchPage({
      observer: "unobserved",
      cluster: "q09",
      indexId: "case_law_v5_cs_sk",
      query: "text:promlčení",
      limit: 10,
      order,
      parsedCursor,
      snippetFields: [],
      projectionRevisionField: "projection_revision",
      extractId: (hit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: (score) => score,
      rankCandidates: async (candidates) => ({
        context: null,
        revisionById: testRevisionsFor(candidates),
        groups: recurringDocumentTokens(
          candidates.filter((candidate) =>
            candidate.id.startsWith("zz-match-"),
          ),
        ),
        ranked: candidates
          .filter(
            (candidate) =>
              candidate.id.startsWith("zz-match-") &&
              !parsedCursor?.excludedGroups?.includes(
                corpusSearchGroupToken(candidate.id),
              ),
          )
          .map((candidate) => ({
            id: candidate.id,
            score: candidate.score,
            lexicalScore: candidate.score,
            citationAuthority: 0,
          })),
      }),
    });

  test.each([
    ["relevance", RELEVANCE_ORDER],
    ["newest", { type: "newest", timestampField: "decision_date_ts" }],
  ] as const)(
    "%s paging reaches every match after consecutive empty windows",
    async (_sort, order) => {
      for (const emptyWindows of [1, 2]) {
        engineHits = [
          ...Array.from({ length: reachable * emptyWindows }, (_, index) => ({
            document_id: `filtered-${String(index)}`,
          })),
          { document_id: "zz-match-a" },
          { document_id: "zz-match-b" },
        ];
        let cursor: SearchCursor | null = null;
        for (let window = 0; window < emptyWindows; window += 1) {
          requestBodies = [];
          const page = await readFilteredPage(cursor, order);

          expect(page.pageRanked).toEqual([]);
          expect(page.scan.roundCapHit).toBe(true);
          expect(page.scan.passagesScanned).toBe(reachable);
          expect(scanRequestCount()).toBe(LIMITS.corpusIndexSearchMaxRounds);
          expect(page.nextCursor?.windowStart).toBe(reachable * (window + 1));
          expect(page.nextCursor?.sort).toBe(order.type);
          cursor = page.nextCursor;
        }
        requestBodies = [];
        const last = await readFilteredPage(cursor, order);

        expect(last.pageRanked.map((hit) => hit.id)).toEqual([
          "zz-match-a",
          "zz-match-b",
        ]);
        expect(last.nextCursor).toBeNull();
        expect(scanRequestCount()).toBe(1);
      }
    },
  );

  test("an empty window at engine exhaustion has no continuation", async () => {
    engineHits = Array.from({ length: reachable }, (_, index) => ({
      document_id: `filtered-${String(index)}`,
    }));

    const page = await readFilteredPage(null, RELEVANCE_ORDER);

    expect(page.pageRanked).toEqual([]);
    expect(page.scan.passagesScanned).toBe(reachable);
    expect(page.nextCursor).toBeNull();
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

describe("split legislation stays one hit across cursor pages", () => {
  test("each act appears once even when several passages match", async () => {
    const acts = ["act-a", "act-b", "act-c", "act-d"];
    // Split acts can have many matching passages. Interleaving the hits also
    // ensures grouping does not depend on passages being adjacent.
    engineHits = [0, 1, 2].flatMap(() =>
      acts.map((documentId) => ({ document_id: documentId })),
    );

    const readLegislationPage = async (parsedCursor: SearchCursor | null) =>
      await readCorpusIndexSearchPage({
        observer: "unobserved",
        cluster: "q09",
        indexId: "legislation_v2",
        query: "text:ustanovení",
        limit: 2,
        order: RELEVANCE_ORDER,
        parsedCursor,
        snippetFields: [],
        projectionRevisionField: "projection_revision",
        extractId: (hit: CorpusIndexHit) =>
          typeof hit["document_id"] === "string" ? hit["document_id"] : null,
        extractSnippet: () => null,
        unseenScoreUpperBound: () => 0,
        rankCandidates: async (candidates) => ({
          context: null,
          revisionById: testRevisionsFor(candidates),
          groups: recurringDocumentTokens(candidates),
          ranked: candidates
            .filter(
              (candidate) =>
                !parsedCursor?.excludedGroups?.includes(
                  corpusSearchGroupToken(candidate.id),
                ),
            )
            .map((candidate) => ({
              id: candidate.id,
              score: candidate.score,
              lexicalScore: candidate.score,
              citationAuthority: 0,
            })),
        }),
      });

    const seen: string[] = [];
    let cursor: SearchCursor | null = null;
    for (const expectedIds of [acts.slice(0, 2), acts.slice(2)]) {
      const page = await readLegislationPage(cursor);
      expect(page.pageRanked.map((hit) => hit.id)).toEqual(expectedIds);
      seen.push(...page.pageRanked.map((hit) => hit.id));
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }

    expect(seen).toEqual(acts);
    expect(new Set(seen).size).toBe(seen.length);
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
      observer: "unobserved",
      cluster: "q09",
      indexId: "case_law_v5_eu",
      query: "text:google",
      limit,
      order: RELEVANCE_ORDER,
      parsedCursor,
      snippetFields: ["text"],
      projectionRevisionField: "projection_revision",
      extractId: (hit: CorpusIndexHit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: (score) => score,
      rankCandidates: async (candidates) => {
        const { representatives, groupTokenById } = collapseByLanguageGroup(
          candidates.map((candidate) => ({
            id: candidate.id,
            score: candidate.score,
            lexicalScore: candidate.score,
            citationAuthority: 0,
          })),
          groupOf,
        );
        const recurring = recurringFixtureIdentities((id) => groupOf(id) ?? id);
        return {
          context: null,
          revisionById: testRevisionsFor(candidates),
          ranked: representatives.filter(
            (hit) =>
              !parsedCursor?.excludedGroups?.includes(
                groupTokenById.get(hit.id) ??
                  panic("Missing representative token"),
              ),
          ),
          groups: [...groupTokenById]
            .filter(([id]) => recurring.has(groupOf(id) ?? id))
            .map(([, token]) => token),
        };
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

  test.each([1, 2, 3])(
    "a complete interleaved walk at limit %i preserves every group",
    async (limit) => {
      for (const reverse of [false, true]) {
        const variants = Array.from({ length: 12 }, (_, index) => [
          { document_id: `c-131-12-l${index}` },
          { document_id: `other-${index}` },
          { document_id: `other-${index}`, chunk_id: `repeat-${index}` },
        ]).flat();
        engineHits = reverse ? variants.toReversed() : variants;
        const seen: string[] = [];
        let cursor: SearchCursor | null = null;
        for (let pageIndex = 0; pageIndex < 30; pageIndex += 1) {
          const page = await readFoldedPage(limit, cursor);
          seen.push(...page.pageRanked.map((hit) => groupOf(hit.id) ?? hit.id));
          cursor = page.nextCursor;
          if (cursor === null) {
            break;
          }
        }
        expect(cursor).toBeNull();
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.toSorted()).toEqual(
          [
            "ECLI:EU:C:2014:317",
            ...Array.from({ length: 12 }, (_, index) => `other-${index}`),
          ].toSorted(),
        );
      }
    },
  );

  test.each([1, 2, 3])(
    "a capped language-group walk at limit %i excludes earlier groups and singletons",
    async (limit) => {
      const reachable =
        LIMITS.corpusIndexSearchMaxRounds *
        LIMITS.corpusIndexSearchCandidateLimit;
      engineHits = [
        { document_id: "c-131-12-first" },
        { document_id: "other-first" },
        { document_id: "other-second" },
        ...Array.from({ length: reachable - 3 }, (_, index) => ({
          document_id: "c-131-12-first",
          chunk_id: `passage-${index}`,
        })),
        { document_id: "c-131-12-late" },
        { document_id: "other-first" },
        { document_id: "other-new" },
      ];
      const seen: string[] = [];
      let cursor: SearchCursor | null = null;
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const page = await readFoldedPage(limit, cursor);
        seen.push(...page.pageRanked.map((hit) => groupOf(hit.id) ?? hit.id));
        cursor = page.nextCursor;
        if (cursor === null) {
          break;
        }
      }
      expect(cursor).toBeNull();
      expect(seen).toEqual([
        "ECLI:EU:C:2014:317",
        "other-first",
        "other-second",
        "other-new",
      ]);
    },
  );

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
  /** A page clause, narrowed to the revision the ranker reported as applied. */
  const current = (clause: string, id: string): string =>
    `(${clause} AND projection_revision:"${testRevisionOf(id)}")`;

  test("the scan asks for no highlighting and current chunks use one page request", async () => {
    engineHits = Array.from({ length: 5000 }, (_, index) => ({
      chunk_id: `doc-${index}:0`,
      document_id: `doc-${index}`,
      anchor_id: `anchor-${index}`,
    }));

    const page = await readPage(3);

    expect(scanRequestCount()).toBeGreaterThan(0);
    expect(snippetRequests()).toHaveLength(1);
    expect(page.scan.highlightRounds).toBe(1);
    const snippetRequest = snippetRequests().at(0);
    expect(snippetRequest?.["snippet_fields"]).toBe("text");
    for (const request of snippetRequests()) {
      expect(request["max_hits"]).toBe(3);
    }
    expect(snippetRequest?.["query"]).toBe(
      `(text:promlčení) AND (${[0, 1, 2].map((i) => current(`chunk_id:"doc-${i}:0"`, `doc-${i}`)).join(" OR ")})`,
    );
  });

  test("every round asks for a compact response body", async () => {
    engineHits = Array.from({ length: 5000 }, (_, index) => ({
      chunk_id: `doc-${index}:0`,
      document_id: `doc-${index}`,
      anchor_id: `anchor-${index}`,
    }));

    await readPage(3);

    // The engine's own default is `pretty_json`. A scan round returns a few
    // hundred whole stored documents, so the indentation is bytes the reader
    // waits on and no parser needs. The endpoint offers no per-hit field
    // projection, which makes this the round's only width control.
    expect(requestBodies.length).toBeGreaterThan(1);
    for (const body of requestBodies) {
      expect(body["format"]).toBe("json");
    }
    expect(snippetRequests()).toHaveLength(1);
  });

  test("a cursor page highlights its own passages, not the previous page's", async () => {
    engineHits = Array.from({ length: 5000 }, (_, index) => ({
      chunk_id: `doc-${index}:0`,
      document_id: `doc-${index}`,
      anchor_id: `anchor-${index}`,
    }));

    const first = await readPage(3);
    requestBodies = [];
    const second = await readPage(3, first.nextCursor);

    // Snippets travel with the page, not with the scan, so a continuation
    // cuts its own: the round names the passages this page emits and none of
    // the ones the reader already has.
    expect(second.pageRanked.map((hit) => hit.id)).toEqual([
      "doc-3",
      "doc-4",
      "doc-5",
    ]);
    expect(snippetRequests()).toHaveLength(1);
    expect(second.scan.highlightRounds).toBe(1);
    expect(snippetRequests().at(0)?.["query"]).toBe(
      `(text:promlčení) AND (${[3, 4, 5].map((i) => current(`chunk_id:"doc-${i}:0"`, `doc-${i}`)).join(" OR ")})`,
    );
    for (const hit of second.pageRanked) {
      expect(second.snippetById.get(hit.id)).toBe(`snip ${hit.id}`);
    }
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
      `(text:promlčení) AND (${current('document_id:"doc-a"', "doc-a")} OR ${current('document_id:"doc-b"', "doc-b")})`,
    );
    expect(page.snippetById.get("doc-a")).toBe("whole doc-a");
  });

  test("the best matching passage within the applied revision supplies the snippet", async () => {
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

    // The document clause lets the applied revision choose its own best
    // matching passage, which also supplies the deep-link anchor.
    expect(snippetRequests().at(0)?.["query"]).toBe(
      `(text:promlčení) AND (${current('chunk_id:"doc-b:7"', "doc-b")} OR ${current('chunk_id:"doc-a:2"', "doc-a")})`,
    );
    expect(page.snippetById.get("doc-a")).toBe("passage doc-a:2");
  });

  test("a passage flood cannot take another emitted document's highlight slot", async () => {
    const hits = [
      ...Array.from({ length: 40 }, (_, index) => ({
        document_id: "doc-a",
        chunk_id: `doc-a:${index}`,
        anchor_id: `a-${index}`,
      })),
      { document_id: "doc-b", chunk_id: "doc-b:0", anchor_id: "b-0" },
    ];
    const stub = async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const body: Record<string, unknown> =
        typeof init?.body === "string" ? JSON.parse(init.body) : {};
      requestBodies.push(body);
      const query = String(body["query"]);
      const matching =
        body["snippet_fields"] === undefined
          ? hits
          : hits.filter((hit) =>
              ["document_id", "chunk_id"].some((field) =>
                query.includes(
                  `(${field}:"${field === "document_id" ? hit.document_id : hit.chunk_id}" AND projection_revision:"${testRevisionOf(hit.document_id)}")`,
                ),
              ),
            );
      const selected = matching.slice(0, Number(body["max_hits"]));
      return new Response(
        JSON.stringify({
          num_hits: matching.length,
          hits: selected,
          snippets: selected.map((hit) => ({
            text: [`passage ${hit.chunk_id}`],
          })),
        }),
        { status: 200 },
      );
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
    const page = await readPage(2);
    expect(
      hits.filter(({ document_id }) => document_id === "doc-a").length,
    ).toBeGreaterThan(page.pageRanked.length * 4);
    expect(page.pageRanked.map(({ id }) => id)).toEqual(["doc-a", "doc-b"]);
    expect(page.snippetById.get("doc-a")).toBe("passage doc-a:0");
    expect(page.anchorIdById.get("doc-a")).toBe("a-0");
    expect(page.snippetById.get("doc-b")).toBe("passage doc-b:0");
    expect(page.anchorIdById.get("doc-b")).toBe("b-0");
  });

  test.each([25, 100])(
    "a page of %i current documents uses one highlight call",
    async (pageSize) => {
      requestDelayMs = 20;
      engineHits = Array.from({ length: pageSize }, (_, index) => ({
        document_id: `doc-${index}`,
        chunk_id: `doc-${index}:0`,
        anchor_id: `anchor-${index}`,
      }));
      const page = await readPage(pageSize);
      expect(peakHighlightInFlight).toBe(1);
      expect(highlightInFlight).toBe(0);
      expect(snippetRequests()).toHaveLength(1);
      expect(page.scan.rounds).toBe(1);
      expect(requestBodies).toHaveLength(2);
      expect(page.scan.highlightRounds).toBe(1);
      expect(page.snippetById.size).toBe(pageSize);
      expect(page.anchorIdById.size).toBe(pageSize);
    },
  );

  test.each(["document", "passage"])(
    "100 current unanchored %s results need no fallback",
    async (granularity) => {
      engineHits = Array.from({ length: 100 }, (_, index) => ({
        document_id: `doc-${index}`,
        ...(granularity === "passage" ? { chunk_id: `doc-${index}:0` } : {}),
      }));
      const page = await readPage(100);
      expect(page.snippetById.size).toBe(100);
      expect(page.anchorIdById.size).toBe(0);
      expect(scanRequestCount()).toBe(1);
      expect(snippetRequests()).toHaveLength(1);
      expect(requestBodies).toHaveLength(2);
      expect(page.scan.highlightRounds).toBe(1);
    },
  );

  test.each([0, 1, 12])(
    "only %i superseded chunks need per-document fallback",
    async (supersededCount) => {
      const currentHits = Array.from({ length: 20 }, (_, index) => ({
        document_id: `doc-${index}`,
        chunk_id: `doc-${index}:0`,
        anchor_id: `anchor-${index}`,
      }));
      const scanned = currentHits.map((hit, index) => ({
        ...hit,
        chunk_id:
          index < supersededCount ? `${hit.document_id}:5` : hit.chunk_id,
      }));
      let inFlight = 0;
      let peak = 0;
      const stub = async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const body: Record<string, unknown> =
          typeof init?.body === "string" ? JSON.parse(init.body) : {};
        requestBodies.push(body);
        const highlighting = body["snippet_fields"] !== undefined;
        const query = String(body["query"]);
        const matching = highlighting
          ? currentHits.filter((hit) =>
              ["document_id", "chunk_id"].some((field) =>
                query.includes(
                  current(
                    `${field}:"${field === "document_id" ? hit.document_id : hit.chunk_id}"`,
                    hit.document_id,
                  ),
                ),
              ),
            )
          : scanned;
        if (highlighting) {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await Bun.sleep(10);
          inFlight -= 1;
        }
        const selected = matching.slice(0, Number(body["max_hits"]));
        return new Response(
          JSON.stringify({
            num_hits: matching.length,
            hits: selected,
            snippets: selected.map((hit) => ({
              text: [`current ${hit.document_id}`],
            })),
          }),
        );
      };
      globalThis.fetch = Object.assign(stub, {
        preconnect: originalFetch.preconnect,
      });
      const page = await readPage(20);
      expect(scanRequestCount()).toBe(1);
      expect(snippetRequests()).toHaveLength(1 + supersededCount);
      expect(requestBodies).toHaveLength(2 + supersededCount);
      expect(page.scan.highlightRounds).toBe(1 + supersededCount);
      expect(peak).toBe(
        Math.max(
          1,
          Math.min(supersededCount, LIMITS.corpusIndexHighlightConcurrency),
        ),
      );
      for (const hit of currentHits) {
        expect(page.snippetById.get(hit.document_id)).toBe(
          `current ${hit.document_id}`,
        );
        expect(page.anchorIdById.get(hit.document_id)).toBe(hit.anchor_id);
      }
    },
  );

  test("an expired shared highlight deadline prevents further dispatch", async () => {
    engineHits = Array.from({ length: 6 }, (_, index) => ({
      document_id: `doc-${index}`,
    }));
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const engine = globalThis.fetch;
    const stub = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const body: Record<string, unknown> =
        typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (
        body["snippet_fields"] !== undefined &&
        snippetRequests().length === 0
      ) {
        now = CORPUS_INDEX_SEARCH_TIMEOUT_MS + 1;
        requestBodies.push(body);
        return new Response(
          JSON.stringify({ num_hits: 0, hits: [], snippets: [] }),
        );
      }
      return engine(input, init);
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
    // The batch consumes the shared budget; missing passages do not
    // receive a fresh timeout for their fallback requests.
    expect(await rejectionOf(readPage(6))).toMatchObject({
      status: 503,
      code: "search_index_unavailable",
    });
    expect(snippetRequests()).toHaveLength(1);
    clock.mockRestore();
  });

  test("an empty page asks the engine for nothing to highlight", async () => {
    responseBody = { num_hits: 0, hits: [] };

    const page = await readPage();

    expect(page.pageRanked).toEqual([]);
    expect(page.snippetById.size).toBe(0);
    expect(snippetRequests()).toEqual([]);
    expect(page.scan.highlightRounds).toBe(0);
  });

  test("a current revision selects its best passage when the superseded chunk differs", async () => {
    // Mid-refresh: ingestion has appended doc-a's new revision and the engine
    // has not applied the delete of the old one, so the scan reaches both.
    const scanned = [
      { document_id: "doc-a", chunk_id: "doc-a:5", anchor_id: "a-old" },
      { document_id: "doc-b", chunk_id: "doc-b:0", anchor_id: "b-current" },
      { document_id: "doc-c", chunk_id: "doc-c:0", anchor_id: "c-current" },
    ];
    responseBody = {
      num_hits: scanned.length,
      hits: scanned,
      snippets: scanned.map(() => ({ text: ["scanned"] })),
    };
    const supersededRevision = "0b6f3a52-1d7e-4f0a-9c2b-5e8d7a6f4c31";
    // Every physical copy the index holds, best first: the superseded copy of
    // doc-a outranks its current one.
    const copies = [
      {
        hit: { document_id: "doc-a", chunk_id: "doc-a:5", anchor_id: "a-old" },
        revision: supersededRevision,
        text: "doc-a superseded",
      },
      {
        hit: { document_id: "doc-a", chunk_id: "doc-a:0", anchor_id: "a-new" },
        revision: testRevisionOf("doc-a"),
        text: "doc-a current",
      },
      {
        hit: {
          document_id: "doc-b",
          chunk_id: "doc-b:0",
          anchor_id: "b-current",
        },
        revision: testRevisionOf("doc-b"),
        text: "doc-b current",
      },
      {
        hit: {
          document_id: "doc-c",
          chunk_id: "doc-c:0",
          anchor_id: "c-current",
        },
        revision: testRevisionOf("doc-c"),
        text: "doc-c current",
      },
    ];
    const scanStub = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const body: Record<string, unknown> =
          typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body["snippet_fields"] === undefined) {
          return await scanStub(input, init);
        }
        requestBodies.push(body);
        // The engine answers a revision-narrowed clause with that copy only.
        const query = String(body["query"]);
        const answered = copies.filter(({ hit, revision }) =>
          ["document_id", "chunk_id"].some((field) =>
            query.includes(
              `(${field}:"${field === "document_id" ? hit.document_id : hit.chunk_id}" AND projection_revision:"${revision}")`,
            ),
          ),
        );
        return new Response(
          JSON.stringify({
            num_hits: answered.length,
            hits: answered.map(({ hit }) => hit),
            snippets: answered.map(({ text }) => ({ text: [text] })),
          }),
          { status: 200 },
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    const page = await readPage();

    expect(page.snippetById.get("doc-a")).toBe("doc-a current");
    expect(page.anchorIdById.get("doc-a")).toBe("a-new");
    // One clause per document, each narrowed to its applied revision.
    expect(snippetRequests().map((request) => request["query"])).toEqual([
      `(text:promlčení) AND (${current('chunk_id:"doc-a:5"', "doc-a")} OR ${current('chunk_id:"doc-b:0"', "doc-b")} OR ${current('chunk_id:"doc-c:0"', "doc-c")})`,
      `(text:promlčení) AND (${current('document_id:"doc-a"', "doc-a")})`,
    ]);
    expect(page.snippetById.get("doc-b")).toBe("doc-b current");
    expect(page.snippetById.get("doc-c")).toBe("doc-c current");
    expect([...page.snippetById.values()]).not.toContain("doc-a superseded");
    expect([...page.anchorIdById.values()]).not.toContain("a-old");
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
      anchor_id: `anchor-${index}`,
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
      anchor_id: `anchor-${index}`,
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

/**
 * The client hands back a typed `CorpusIndexError` precisely so the failure can
 * be named. These pin that the read spends it on a status instead of letting
 * the value escape for the handler boundary to grade as an internal fault.
 */
describe("an engine refusal reaches the caller as a mapped status", () => {
  const readPageFailure = async (): Promise<unknown> =>
    await readPage().then(
      () => null,
      (error: unknown) => error,
    );

  test("the engine's own 5xx is answered as 503", async () => {
    engineFailureStatus = 500;

    const failure = await readPageFailure();

    if (!HandlerError.is(failure)) {
      throw new Error("the read did not fail with a HandlerError");
    }
    // The engine reports overload as a 500, so this is the busy case too.
    expect(failure.status).toBe(503);
    expect(failure.cause).toBeDefined();
  });

  test("a request the engine refused is answered as 502", async () => {
    engineFailureStatus = 400;

    const failure = await readPageFailure();

    if (!HandlerError.is(failure)) {
      throw new Error("the read did not fail with a HandlerError");
    }
    // A malformed query is this module's doing; retrying cannot fix it.
    expect(failure.status).toBe(502);
  });

  test("the highlight round maps its refusal the same way", async () => {
    const hits = [{ document_id: "doc-a", seq: 1 }];
    responseBody = {
      num_hits: hits.length,
      hits,
      snippets: hits.map(() => ({ text: ["passage"] })),
    };
    // Only the highlight round asks for snippet fields, so failing on that
    // request alone reaches the second read site with a page already scanned.
    snippetResponseBody = null;
    const stubbedFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const body: Record<string, unknown> =
          typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body["snippet_fields"] !== undefined) {
          return new Response("engine refused the highlight", { status: 503 });
        }
        return await stubbedFetch(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );

    const failure = await readPageFailure();

    if (!HandlerError.is(failure)) {
      throw new Error("the read did not fail with a HandlerError");
    }
    expect(failure.status).toBe(503);
  });
});

/**
 * A cursor bounds a position in the order that produced it, so it has to say
 * which order that was: applying a date-ordered boundary to a relevance scan
 * would skip and repeat decisions behind an ordinary-looking page. These hold
 * the scan to naming its own order on every cursor it issues, and to resuming
 * a date-ordered window where it left off.
 */
describe("a page boundary carries the order it was cut from", () => {
  beforeEach(() => {
    engineHits = Array.from({ length: 8 }, (_, index) => ({
      document_id: `doc-${String(index)}`,
    }));
  });

  test.each([
    ["relevance", RELEVANCE_ORDER],
    ["newest", { type: "newest", timestampField: "decision_date_ts" }],
  ] as const)("a %s page names its own order", async (sort, order) => {
    const page = await readPage(3, null, order);

    expect(page.nextCursor?.sort).toBe(sort);
  });

  test("a date-ordered scan resumes after its own cursor", async () => {
    const newest = {
      type: "newest",
      timestampField: "decision_date_ts",
    } as const;

    const first = await readPage(3, null, newest);
    const second = await readPage(3, first.nextCursor, newest);

    expect(first.pageRanked.map((hit) => hit.id)).toEqual([
      "doc-0",
      "doc-1",
      "doc-2",
    ]);
    expect(second.pageRanked.map((hit) => hit.id)).toEqual([
      "doc-3",
      "doc-4",
      "doc-5",
    ]);
    expect(second.nextCursor?.sort).toBe("newest");
  });
});

describe("folded acts stay folded across capped windows", () => {
  const reachable =
    LIMITS.corpusIndexSearchMaxRounds * LIMITS.corpusIndexSearchCandidateLimit;
  /** Acts behind the first window's other hits, several versions each. */
  const FILLER_ACTS = 150;
  /** `<act>#<version>`: every version of an act folds into the act. */
  const actOf = (id: string): string => id.split("#")[0] ?? id;
  const fillerAct = (index: number) =>
    `act-${String(index % FILLER_ACTS).padStart(3, "0")}`;

  const readActPage = async (
    limit: number,
    parsedCursor: SearchCursor | null,
  ) =>
    await readCorpusIndexSearchPage({
      observer: "unobserved",
      cluster: "q09",
      indexId: "legislation_v2_cze",
      query: "text:smlouva",
      limit,
      order: RELEVANCE_ORDER,
      parsedCursor,
      snippetFields: ["text"],
      projectionRevisionField: "projection_revision",
      extractId: (hit: CorpusIndexHit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      // No bound ever proves the page: only the round cap ends a scan.
      unseenScoreUpperBound: (score) => score + 1,
      rankCandidates: async (candidates) => {
        const collapsed = collapseLegislationHitsByWork({
          ranked: candidates
            .filter(
              (candidate) =>
                !parsedCursor?.excludedGroups?.includes(
                  corpusSearchGroupToken(candidate.id),
                ),
            )
            .map((candidate) => ({
              id: candidate.id,
              work: actOf(candidate.id),
              score: candidate.score,
              lexicalScore: candidate.score,
              citationAuthority: 0,
            })),
          representatives: new Map(),
          namedWorks: [],
          namedScoreFloor: 10,
          excludedWork: parsedCursor === null ? null : actOf(parsedCursor.id),
          excludedWorkTokens: new Set(parsedCursor?.excludedGroups),
        });
        const recurringTokens = new Set(
          [...recurringFixtureIdentities(actOf)].map((work) =>
            corpusSearchGroupToken(work),
          ),
        );
        return {
          context: null,
          revisionById: testRevisionsFor(candidates),
          ranked: collapsed.ranked,
          groups: collapsed.workTokens.filter(
            (token) =>
              recurringTokens.has(token) ||
              (parsedCursor !== null &&
                token === corpusSearchGroupToken(actOf(parsedCursor.id))),
          ),
        };
      },
    });

  test.each([1, 2, 3])(
    "a moved Work window at limit %i carries the cursor Work",
    async (limit) => {
      engineHits = [
        { document_id: "act-a#1" },
        { document_id: "act-b#1" },
        { document_id: "act-c#1" },
        ...Array.from({ length: reachable - 3 }, (_, index) => ({
          document_id: "act-a#1",
          chunk_id: `passage-${index}`,
        })),
        { document_id: "act-b#2" },
        { document_id: "act-d#1" },
      ];
      const seen: string[] = [];
      let cursor: SearchCursor | null = null;
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const page = await readActPage(limit, cursor);
        seen.push(...page.pageRanked.map((hit) => actOf(hit.id)));
        cursor = page.nextCursor;
        if (cursor === null) {
          break;
        }
      }
      expect(cursor).toBeNull();
      expect(seen).toEqual(["act-a", "act-b", "act-c", "act-d"]);
    },
  );

  test("an act shown before a window move does not come back from a deeper version", async () => {
    // Act A's best version opens the first window, which the other acts fill
    // with several versions each; a deeper version of A, and of every other
    // act, sits in the second window beside acts never seen before.
    engineHits = [
      { document_id: "act-a#2020" },
      ...Array.from({ length: reachable - 1 }, (_, index) => ({
        document_id: `${fillerAct(index)}#${String(index)}`,
      })),
      { document_id: "act-a#2014" },
      ...Array.from({ length: FILLER_ACTS }, (_, index) => ({
        document_id: `${fillerAct(index)}#late`,
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        document_id: `late-${String(index).padStart(2, "0")}#1`,
      })),
    ];

    const first = await readActPage(200, null);

    expect(first.scan.roundCapHit).toBe(true);
    expect(first.pageRanked).toHaveLength(FILLER_ACTS + 1);
    expect(first.nextCursor?.windowStart).toBe(reachable);
    expect(first.nextCursor?.excludedGroups).toHaveLength(FILLER_ACTS + 1);

    const second = await readActPage(200, first.nextCursor);
    const firstActs = new Set(first.pageRanked.map((hit) => actOf(hit.id)));
    const secondActs = second.pageRanked.map((hit) => actOf(hit.id));

    expect(secondActs.some((act) => firstActs.has(act))).toBe(false);
    expect(secondActs.toSorted()).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `late-${String(index).padStart(2, "0")}`,
      ),
    );
  });

  test("an empty window preserves groups excluded by earlier windows", async () => {
    engineHits = [
      ...Array.from({ length: reachable }, () => ({
        document_id: "act-a#2020",
      })),
      ...Array.from({ length: reachable }, () => ({
        document_id: "act-a#2014",
      })),
      { document_id: "act-a#2010" },
      { document_id: "act-b#2020" },
    ];

    const first = await readActPage(10, null);
    const empty = await readActPage(10, first.nextCursor);

    expect(first.pageRanked.map((hit) => actOf(hit.id))).toEqual(["act-a"]);
    expect(first.nextCursor?.excludedGroups).toHaveLength(1);
    expect(empty.pageRanked).toEqual([]);
    expect(empty.nextCursor?.windowStart).toBe(reachable * 2);
    expect(empty.nextCursor?.excludedGroups).toEqual(
      first.nextCursor?.excludedGroups,
    );

    const last = await readActPage(10, empty.nextCursor);

    expect(last.pageRanked.map((hit) => actOf(hit.id))).toEqual(["act-b"]);
    expect(last.nextCursor).toBeNull();
  });

  test("a continuation that would carry too many acts reports truncation", async () => {
    engineHits = [
      ...Array.from({ length: reachable }, (_, index) => ({
        document_id: `act-${String(index).padStart(4, "0")}#1`,
      })),
      ...Array.from({ length: reachable }, (_, index) => ({
        document_id: `act-${String(index).padStart(4, "0")}#2`,
      })),
    ];

    const first = await readActPage(reachable, null);

    // The first window held more acts than a cursor may carry, so the reader
    // is not handed a continuation that could repeat one.
    expect(reachable).toBeGreaterThan(
      LIMITS.corpusIndexSearchMaxExcludedGroups,
    );
    expect(first.scan.roundCapHit).toBe(true);
    expect(first.nextCursor).toBeNull();
    expect(first.paginationOutcome).toEqual({
      type: "truncated",
      reason: "exclusion_budget",
    });
  });
});

/**
 * A page addressed by number ranks every result in front of it in the same
 * request, so a jump to page N is one request rather than N - 1 cursor pages
 * walked first. It must land on the decisions the cursor chain reaches, and
 * its deeper reach must not be cut short by the round cap a first page keeps.
 */
describe("a page addressed by offset", () => {
  const documentId = (index: number) => `doc-${String(index).padStart(5, "0")}`;

  type ReadOffsetPageOptions = {
    limit: number;
    parsedCursor?: SearchCursor | null;
    skip: number;
    /** Citation authority per decision; none by default. */
    authorityById?: ReadonlyMap<string, number>;
    /**
     * Which shown decisions the ranker reports as groups a later window must
     * leave out: none by default, or every one (each decision its own group).
     */
    carries?: "none" | "every";
  };

  const readOffsetPage = async ({
    authorityById = new Map(),
    carries = "none",
    limit,
    parsedCursor = null,
    skip,
  }: ReadOffsetPageOptions) =>
    await readCorpusIndexSearchPage({
      observer: "unobserved",
      cluster: "q09",
      indexId: "case_law_v5_cs_sk",
      query: "text:smlouva",
      limit,
      order: RELEVANCE_ORDER,
      parsedCursor,
      skip,
      snippetFields: ["text"],
      projectionRevisionField: "projection_revision",
      extractId: (hit: CorpusIndexHit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: (score) =>
        stableBlendUpperBound(score, DEFAULT_AUTHORITY_WEIGHT),
      // The production contract: leave out the groups the scope names.
      rankCandidates: async (candidates, { excludedGroups }) => {
        const shown = candidates.filter(
          ({ id }) => !excludedGroups.has(corpusSearchGroupToken(id)),
        );
        return {
          context: null,
          groups:
            carries === "every"
              ? shown.map(({ id }) => corpusSearchGroupToken(id))
              : [],
          ranked: blendStableCitationAuthority({
            candidates: shown,
            authorityById: new Map(authorityById),
            weight: DEFAULT_AUTHORITY_WEIGHT,
          }),
          revisionById: testRevisionsFor(shown),
        };
      },
    });

  type ChainInput = Pick<ReadOffsetPageOptions, "authorityById" | "limit"> & {
    /** Stop once the chain has read this many results. */
    until: number;
  };

  /** The cursor chain's results in order, read page by page from the first. */
  const readCursorChain = async ({
    authorityById,
    limit,
    until,
  }: ChainInput) => {
    const chain: string[] = [];
    let cursor: SearchCursor | null = null;
    for (let page = 0; page < 200 && chain.length < until; page += 1) {
      // Each cursor page needs the previous page's cursor.
      const read = await readOffsetPage({
        ...(authorityById === undefined ? {} : { authorityById }),
        limit,
        parsedCursor: cursor,
        skip: 0,
      });
      chain.push(...read.pageRanked.map((hit) => hit.id));
      if (read.nextCursor === null) {
        break;
      }
      cursor = read.nextCursor;
    }
    return chain;
  };

  test("any page by offset is that page of the cursor chain, whatever the ranking found deeper", async () => {
    // Decisions match a varying number of passages, so the chain's first
    // windows end before every decision is scanned, and some decisions the
    // first scan never reached carry enough citation authority to rank
    // above ones it already showed. A deeper scan that re-ranked everything
    // would reorder what earlier pages showed; the chain does not.
    await assertProperty(
      "any page by offset is that page of the cursor chain, whatever the ranking found deeper",
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 8 }), {
          minLength: 150,
          maxLength: 260,
        }),
        fc.array(fc.double({ min: 0, max: 50, noNaN: true }), {
          minLength: 260,
          maxLength: 260,
        }),
        fc.integer({ min: 5, max: 40 }),
        async (passagesPerDocument, authorities, limit) => {
          engineHits = passagesPerDocument.flatMap((count, index) =>
            Array.from({ length: count }, (_, passage) => ({
              document_id: documentId(index),
              anchor_id: `d${String(index)}p${String(passage)}`,
            })),
          );
          const authorityById = new Map(
            passagesPerDocument.map((_, index) => [
              documentId(index),
              // Deep decisions weigh most: the first scan cannot see them.
              (authorities.at(index) ?? 0) *
                (index / passagesPerDocument.length),
            ]),
          );
          const pages = 4;
          const chain = await readCursorChain({
            authorityById,
            limit,
            until: pages * limit,
          });

          const byOffset: string[][] = [];
          for (let page = 1; page < pages; page += 1) {
            // Sequential only to keep the fake engine's request log readable.
            const read = await readOffsetPage({
              authorityById,
              limit,
              skip: page * limit,
            });
            byOffset.push(read.pageRanked.map((hit) => hit.id));
          }

          // Page 1 then the offset pages are the chain's prefix: no repeat,
          // no gap, in the chain's order.
          expect([...chain.slice(0, limit), ...byOffset.flat()]).toEqual(
            chain.slice(0, pages * limit),
          );
        },
      ),
      { numRuns: 20 },
    );
  });

  test("every offset page holds the decisions the cursor chain reaches", async () => {
    engineHits = Array.from({ length: 30_000 }, (_, index) => ({
      document_id: documentId(index),
    }));
    const limit = 20;
    const chain: string[][] = [];
    let cursor: SearchCursor | null = null;
    for (let page = 0; page < 6; page += 1) {
      // Each cursor page needs the previous page's cursor.
      const read = await readOffsetPage({
        limit,
        parsedCursor: cursor,
        skip: 0,
      });
      chain.push(read.pageRanked.map((hit) => hit.id));
      cursor = read.nextCursor;
    }
    expect(new Set(chain.flat()).size).toBe(6 * limit);

    const jumps = await Promise.all(
      chain.map(
        async (_, index) =>
          await readOffsetPage({ limit, skip: index * limit }),
      ),
    );
    expect(jumps.map((page) => page.pageRanked.map((hit) => hit.id))).toEqual(
      chain,
    );
  });

  test("the deepest page fills even when every decision matched several passages", async () => {
    const passagesPerDocument = 4;
    const documents = LIMITS.caseLawResultDepthMax + 100;
    engineHits = Array.from(
      { length: documents * passagesPerDocument },
      (_, index) => ({
        document_id: documentId(Math.floor(index / passagesPerDocument)),
        anchor_id: `p${String(index)}`,
      }),
    );
    const limit = 20;
    const skip = LIMITS.caseLawResultDepthMax - limit;

    const page = await readOffsetPage({ limit, skip });

    // One window of the chain holds fewer decisions than the page is deep.
    expect(
      LIMITS.corpusIndexSearchMaxRounds *
        LIMITS.corpusIndexSearchCandidateLimit,
    ).toBeLessThan(LIMITS.caseLawResultDepthMax * passagesPerDocument);
    expect(page.reach).toBe(SEARCH_PAGE_REACH.REACHED);
    expect(page.pageRanked.map((hit) => hit.id)).toEqual(
      Array.from({ length: limit }, (_, index) => documentId(skip + index)),
    );
    expect(page.scan.rounds).toBeLessThanOrEqual(
      CORPUS_INDEX_OFFSET_PAGE_MAX_ROUNDS,
    );
  });

  test("following the cursor of a deep offset page continues where the cursor chain does", async () => {
    // Every decision matched four passages, so the deep page ranked well past
    // what a first page's fixed round cap scans.
    const passagesPerDocument = 4;
    const documents = LIMITS.caseLawResultDepthMax + 200;
    engineHits = Array.from(
      { length: documents * passagesPerDocument },
      (_, index) => ({
        document_id: documentId(Math.floor(index / passagesPerDocument)),
        anchor_id: `p${String(index)}`,
      }),
    );
    const limit = 20;
    const skip = LIMITS.caseLawResultDepthMax - limit;
    const continuations = 3;

    // The pure cursor chain, from the first page to past the offset page. Its
    // pages are not all `limit` long (a capped window ends on a short page),
    // so it is compared decision by decision rather than page by page.
    const reachedByChain = skip + limit + continuations * limit;
    const chain: string[] = [];
    let chainCursor: SearchCursor | null = null;
    for (let page = 0; page < 100 && chain.length < reachedByChain; page += 1) {
      const read = await readOffsetPage({
        limit,
        parsedCursor: chainCursor,
        skip: 0,
      });
      chain.push(...read.pageRanked.map((hit) => hit.id));
      if (read.nextCursor === null) {
        break;
      }
      chainCursor = read.nextCursor;
    }
    const chainAfterOffsetPage = chain.slice(skip + limit, reachedByChain);
    expect(chainAfterOffsetPage).toHaveLength(continuations * limit);

    // The offset page, then its own cursor followed.
    const offsetPage = await readOffsetPage({ limit, skip });
    const followed: string[][] = [];
    let cursor = offsetPage.nextCursor;
    for (let page = 0; page < continuations; page += 1) {
      const read = await readOffsetPage({
        limit,
        parsedCursor: cursor,
        skip: 0,
      });
      followed.push(read.pageRanked.map((hit) => hit.id));
      cursor = read.nextCursor;
    }

    expect(followed.flat()).toEqual(chainAfterOffsetPage);
    expect(followed.flat()).toEqual(
      Array.from({ length: continuations * limit }, (_, index) =>
        documentId(skip + limit + index),
      ),
    );
  });

  test("a deep offset page whose decisions matched more passages than the cap assumes reports that its scan stopped short", async () => {
    // Eight passages a decision, twice what the offset round cap budgets for.
    const passagesPerDocument = 8;
    const documents = LIMITS.caseLawResultDepthMax + 100;
    engineHits = Array.from(
      { length: documents * passagesPerDocument },
      (_, index) => ({
        document_id: documentId(Math.floor(index / passagesPerDocument)),
        anchor_id: `p${String(index)}`,
      }),
    );
    const limit = 20;
    const skip = LIMITS.caseLawResultDepthMax - limit;

    const page = await readOffsetPage({ limit, skip });

    // The fixture reaches the fault: the cap ends the scan before the page.
    expect(page.scan.roundCapHit).toBe(true);
    expect(page.pageRanked.length).toBeLessThan(limit);
    // A short page here is not the end of the results.
    expect(page.reach).toBe(SEARCH_PAGE_REACH.SCAN_BUDGET);
    expect(page.nextCursor).toBeNull();
  });

  test("an offset page whose chain ran out of room for its exclusions does not read as the end of the results", async () => {
    // Four passages a decision, so the chain's first window shows 225 of
    // them, and every one is a group the next window must leave out: more
    // than a cursor may carry, so the chain stops there with results left.
    const passagesPerDocument = 4;
    engineHits = Array.from(
      { length: 2000 * passagesPerDocument },
      (_, index) => ({
        document_id: documentId(Math.floor(index / passagesPerDocument)),
        anchor_id: `p${String(index)}`,
      }),
    );
    const firstWindow =
      (LIMITS.corpusIndexSearchMaxRounds *
        LIMITS.corpusIndexSearchCandidateLimit) /
      passagesPerDocument;
    expect(firstWindow).toBeGreaterThan(
      LIMITS.corpusIndexSearchMaxExcludedGroups,
    );
    const limit = 20;
    const skip = 300;
    // The fixture reaches the fault: the page lies past the first window.
    expect(skip).toBeGreaterThan(firstWindow);

    const page = await readOffsetPage({ carries: "every", limit, skip });

    expect(page.pageRanked).toEqual([]);
    expect(page.stop).toEqual({ type: "budget", budget: "exclusion" });
    // Not the end of the results: no cursor, and the page says it was not
    // reached, so the web neither shows it as the last page nor lands back.
    expect(page.reach).toBe(SEARCH_PAGE_REACH.SCAN_BUDGET);
    expect(page.nextCursor).toBeNull();
    expect(page.paginationOutcome).toEqual({
      type: "truncated",
      reason: "exclusion_budget",
    });
  });

  test("a page the scan read to the end of its hits is the end of the results", async () => {
    engineHits = Array.from({ length: 30 }, (_, index) => ({
      document_id: documentId(index),
    }));

    const page = await readOffsetPage({ limit: 20, skip: 20 });

    expect(page.pageRanked).toHaveLength(10);
    expect(page.stop).toEqual({ type: "exhausted" });
    expect(page.reach).toBe(SEARCH_PAGE_REACH.REACHED);
  });

  test("an offset page the scan placed reports that it did", async () => {
    engineHits = Array.from({ length: 2000 }, (_, index) => ({
      document_id: documentId(index),
    }));

    const page = await readOffsetPage({ limit: 20, skip: 100 });

    expect(page.pageRanked).toHaveLength(20);
    expect(page.reach).toBe(SEARCH_PAGE_REACH.REACHED);
  });

  test("with decisions pinned above the text results, offset pages match the cursor chain with no gap or repeat", async () => {
    // The composition the case-law search performs for an entry carrying a
    // reference among other words: the decisions it names are pinned above
    // the first page and dropped from the text ranking on every page.
    engineHits = Array.from({ length: 300 }, (_, index) => ({
      document_id: documentId(index),
    }));
    const limit = 25;
    // One named decision outside the text ranking, one inside page 1's text
    // slice and one inside page 2's.
    const named = ["named-elsewhere", documentId(3), documentId(30)];
    const pinnedIds = new Set(named);
    const pinned = named.map((id) => ({ id }));
    const shown = (
      page: Awaited<ReturnType<typeof readOffsetPage>>,
      prefix: readonly { id: string }[],
    ) =>
      withPinnedDecisions({
        pinned: prefix,
        pinnedIds,
        ranked: page.pageRanked.map(({ id }) => ({ id })),
      }).map(({ id }) => id);

    const firstRead = await readOffsetPage({ limit, skip: 0 });
    const first = shown(firstRead, pinned);
    const byCursor: string[][] = [];
    let cursor = firstRead.nextCursor;
    for (let page = 0; page < 2; page += 1) {
      const read = await readOffsetPage({
        limit,
        parsedCursor: cursor,
        skip: 0,
      });
      byCursor.push(shown(read, []));
      cursor = read.nextCursor;
    }
    const byOffset = await Promise.all(
      [1, 2].map(async (page) =>
        shown(await readOffsetPage({ limit, skip: page * limit }), []),
      ),
    );

    expect(byOffset).toEqual(byCursor);
    const reading = [...first, ...byOffset.flat()];
    expect(new Set(reading).size).toBe(reading.length);
    // Every text result up to the third page's end is read once, in order,
    // after the named decisions.
    expect(reading).toEqual([
      ...named,
      ...Array.from({ length: 3 * limit }, (_, index) =>
        documentId(index),
      ).filter((id) => !pinnedIds.has(id)),
    ]);
  });

  test("a page placed by both a cursor and an offset is a programming error", async () => {
    engineHits = [{ document_id: documentId(0) }];
    const cursor: SearchCursor = {
      score: 1,
      id: documentId(0),
      sort: "relevance",
      windowStart: 0,
    };

    const failure = await rejectionOf(
      readOffsetPage({ limit: 20, parsedCursor: cursor, skip: 20 }),
    );

    expect(failure).toBeInstanceOf(Panic);
    expect(String(failure)).toContain("placed by its cursor or by its offset");
  });
});
