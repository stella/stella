import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusIndexScanTransport,
  NATIVE_SCAN_TRANSPORT,
  readCorpusIndexSearchPage,
  type SearchCursor,
} from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
import {
  type CorpusSearchOrder,
  RELEVANCE_ORDER,
} from "@/api/lib/legal-search/corpus-search-order";
import {
  blendStableCitationAuthority,
  courtTierSignal,
  DEFAULT_AUTHORITY_WEIGHT,
  DEFAULT_COURT_TIER_WEIGHT,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
import { testRevisionsFor } from "@/api/tests/helpers/corpus-projection-revisions";

/**
 * The candidate scan through both engine transports.
 *
 * The fixture engine holds one ordered passage list per case and serves it
 * identically from the native search endpoint and from the ES-compatible one.
 * The order is the fixture's own; what the golden pins is everything the scan
 * derives from that order.
 */
type FixturePassage = {
  document_id: string;
  chunk_id?: string;
  anchor_id?: string;
  text: string;
  score: number;
};

type FixtureCase = {
  passages: FixturePassage[];
  authorityById: Map<string, number>;
  tierById: Map<string, number>;
  limit: number;
};

/**
 * Deterministic PRNG (mulberry32) so the fixture set is the same on every
 * run. The golden was recorded from this exact sequence, so it stays in its
 * bit-arithmetic form.
 */
const mulberry32 = (seed: number) => {
  let state = seed;
  return (): number => {
    // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc -- 32-bit wrap-around is the generator
    state = (state + 0x6d_2b_79_f5) | 0;
    // oxlint-disable-next-line no-bitwise -- the generator's mixing step
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    // oxlint-disable-next-line no-bitwise, operator-assignment -- the generator's mixing step
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    // oxlint-disable-next-line no-bitwise -- unsigned 32-bit output
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

type FixtureShape = {
  name: string;
  seed: number;
  documents: number;
  maxPassagesPerDocument: number;
  limit: number;
  granular: boolean;
  /** Passages of one extra document placed ahead of every other passage. */
  floodPassages?: number;
};

const buildCase = ({
  name,
  seed,
  documents,
  maxPassagesPerDocument,
  limit,
  granular,
  floodPassages = 0,
}: FixtureShape): FixtureCase => {
  const random = mulberry32(seed);
  const passages: FixturePassage[] = [];
  const authorityById = new Map<string, number>();
  const tierById = new Map<string, number>();
  for (let doc = 0; doc < documents; doc += 1) {
    const id = `${name}-doc-${String(doc).padStart(4, "0")}`;
    authorityById.set(
      id,
      random() < 0.6 ? 0 : Math.round(random() * 400) / 100,
    );
    tierById.set(id, 1 + Math.floor(random() * 4));
    const count = granular
      ? 1
      : 1 + Math.floor(random() * random() * maxPassagesPerDocument);
    for (let seq = 0; seq < count; seq += 1) {
      passages.push({
        document_id: id,
        ...(granular
          ? {}
          : { chunk_id: `${id}:${seq}`, anchor_id: `${id}-p${seq}` }),
        text: `passage ${id}:${seq}`,
        // Two decimals, so equal scores (and the engine's tie order) occur.
        score: Math.round((2 + random() * 18) * 100) / 100,
      });
    }
  }
  const flood = Array.from({ length: floodPassages }, (_, seq) => ({
    document_id: `${name}-flood`,
    chunk_id: `${name}-flood:${seq}`,
    anchor_id: `${name}-flood-p${seq}`,
    text: `passage ${name}-flood:${seq}`,
    score: 40 - seq / 100,
  }));
  if (floodPassages > 0) {
    authorityById.set(`${name}-flood`, 0);
    tierById.set(`${name}-flood`, 1);
  }
  // Best-first, ties kept in insertion order: the fixture's own tie-break.
  const ordered = passages
    .map((passage, index) => ({ passage, index }))
    .toSorted((a, b) => b.passage.score - a.passage.score || a.index - b.index)
    .map(({ passage }) => passage);
  return {
    passages: [...flood, ...ordered],
    authorityById,
    tierById,
    limit,
  };
};

const SCORED_SCAN_FIXTURES: readonly FixtureShape[] = [
  {
    name: "small",
    seed: 11,
    documents: 15,
    maxPassagesPerDocument: 4,
    limit: 10,
    granular: false,
  },
  {
    name: "wide",
    seed: 23,
    documents: 700,
    maxPassagesPerDocument: 8,
    limit: 10,
    granular: false,
  },
  {
    name: "deep-page",
    seed: 37,
    documents: 500,
    maxPassagesPerDocument: 14,
    limit: 100,
    granular: false,
  },
  {
    name: "flooded",
    seed: 41,
    documents: 60,
    maxPassagesPerDocument: 120,
    limit: 20,
    granular: false,
  },
  {
    name: "round-cap",
    seed: 61,
    documents: 400,
    maxPassagesPerDocument: 60,
    limit: 100,
    granular: false,
  },
  {
    name: "monopolised",
    seed: 67,
    documents: 80,
    maxPassagesPerDocument: 3,
    limit: 10,
    granular: false,
    floodPassages: 1000,
  },
  {
    name: "granular",
    seed: 53,
    documents: 500,
    maxPassagesPerDocument: 1,
    limit: 25,
    granular: true,
  },
];

type EngineRequest = { url: URL; body: Record<string, unknown> };

const originalFetch = globalThis.fetch;
let active: FixtureCase | null = null;
let engineRequests: EngineRequest[] = [];
let scanRequests: { from: number; size: number; endpoint: string }[] = [];
let highlightRequests: { maxHits: number; clauses: number }[] = [];
/** Rank whose scored hit arrives without `_source`, when a test wants one. */
let sourcelessRank: number | null = null;

const clauseValues = (query: string): Set<string> =>
  new Set(
    [...query.matchAll(/(?:chunk_id|document_id):"([^"]+)"/gu)].map(
      (match) => match[1] ?? "",
    ),
  );

const projected = (
  passage: FixturePassage,
  fields: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(passage).filter(
      ([key]) => key !== "score" && fields.includes(key),
    ),
  );

const stored = (passage: FixturePassage): Record<string, unknown> => {
  const { score: _score, ...rest } = passage;
  return rest;
};

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200 });

beforeEach(() => {
  active = null;
  engineRequests = [];
  scanRequests = [];
  highlightRequests = [];
  sourcelessRank = null;
  const stub = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    engineRequests.push({ url, body });
    const passages = active?.passages ?? [];
    if (url.pathname.includes("/_elastic/")) {
      const from = Number(body["from"] ?? 0);
      const size = Number(body["size"]);
      scanRequests.push({ from, size, endpoint: "scored" });
      const fields = (url.searchParams.get("_source_includes") ?? "").split(
        ",",
      );
      const window = passages.slice(from, from + size);
      return json({
        hits: {
          total: { value: passages.length, relation: "eq" },
          hits: window.map((passage, index) =>
            from + index === sourcelessRank
              ? { sort: [passage.score] }
              : { _source: projected(passage, fields), sort: [passage.score] },
          ),
        },
      });
    }
    if (body["snippet_fields"] !== undefined) {
      const wanted = clauseValues(String(body["query"]));
      highlightRequests.push({
        maxHits: Number(body["max_hits"]),
        clauses: wanted.size,
      });
      const hits = passages
        .filter(
          (passage) =>
            wanted.has(passage.document_id) ||
            wanted.has(passage.chunk_id ?? ""),
        )
        .slice(0, Number(body["max_hits"]));
      return json({
        num_hits: hits.length,
        hits: hits.map(stored),
        snippets: hits.map((passage) => ({ text: [passage.text] })),
      });
    }
    const from = Number(body["start_offset"] ?? 0);
    const size = Number(body["max_hits"]);
    scanRequests.push({ from, size, endpoint: "native" });
    const window = passages.slice(from, from + size);
    return json({
      num_hits: passages.length,
      hits: window.map(stored),
      snippets: [],
    });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BLEND_WEIGHT = DEFAULT_AUTHORITY_WEIGHT + DEFAULT_COURT_TIER_WEIGHT;

const SCORED = {
  type: "scored",
} as const satisfies CorpusIndexScanTransport;

const readFixturePage = async (
  fixture: FixtureCase,
  parsedCursor: SearchCursor | null,
  scanTransport: CorpusIndexScanTransport,
  order: CorpusSearchOrder = RELEVANCE_ORDER,
) => {
  active = fixture;
  return await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "case_law_v5_cs_sk",
    query: "text:fixture",
    limit: fixture.limit,
    order,
    parsedCursor,
    scanTransport,
    snippetFields: ["text"],
    projectionRevisionField: "projection_revision",
    extractId: (hit: CorpusIndexHit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: (snippet) => {
      const text = snippet?.["text"];
      return Array.isArray(text) ? String(text.at(0)) : null;
    },
    unseenScoreUpperBound: (next) => stableBlendUpperBound(next, BLEND_WEIGHT),
    rankCandidates: async (candidates) => ({
      context: null,
      groups: candidates.map((candidate) =>
        corpusSearchGroupToken(candidate.id),
      ),
      ranked: blendStableCitationAuthority({
        candidates: candidates.filter(
          (candidate) =>
            !parsedCursor?.excludedGroups?.includes(
              corpusSearchGroupToken(candidate.id),
            ),
        ),
        authorityById: fixture.authorityById,
        signals: [courtTierSignal(fixture.tierById)],
      }),
      revisionById: testRevisionsFor(candidates),
    }),
  });
};

type PageRead = Awaited<ReturnType<typeof readFixturePage>>;

/** Everything a reader or a continuation can observe, minus wall time. */
const observable = (page: PageRead) => {
  const { indexMs: _indexMs, ...scan } = page.scan;
  // The per-document maps cover every document the scan reached, so they are
  // pinned by digest rather than spelled out.
  const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  };
  const digest = <V>(map: ReadonlyMap<string, V>) =>
    new Bun.CryptoHasher("sha256")
      .update(JSON.stringify([...map].toSorted(byKey)))
      .digest("hex");
  return {
    pageRanked: page.pageRanked,
    nextCursor: page.nextCursor,
    passageCountById: digest(page.passageCountById),
    snippetById: digest(page.snippetById),
    scan,
    scanRequests: scanRequests.map(({ from, size }) => ({ from, size })),
    highlightRequests: {
      count: highlightRequests.length,
      shapes: [
        ...new Map(
          highlightRequests.map((request) => [
            JSON.stringify(request),
            request,
          ]),
        ).values(),
      ],
    },
  };
};

/** Page one, then the page its cursor continues to, for every fixture. */
const readFixtureSequence = async (transport: CorpusIndexScanTransport) => {
  const out: Record<string, ReturnType<typeof observable>> = {};
  const endpoints = new Set<string>();
  for (const shape of SCORED_SCAN_FIXTURES) {
    const fixture = buildCase(shape);
    scanRequests = [];
    highlightRequests = [];
    const first = await readFixturePage(fixture, null, transport);
    out[`${shape.name}:1`] = observable(first);
    for (const request of scanRequests) {
      endpoints.add(request.endpoint);
    }
    if (first.nextCursor !== null) {
      scanRequests = [];
      highlightRequests = [];
      const second = await readFixturePage(
        fixture,
        first.nextCursor,
        transport,
      );
      out[`${shape.name}:2`] = observable(second);
    }
  }
  return { pages: out, endpoints };
};

const readGolden = async (): Promise<unknown> =>
  await Bun.file(
    new URL("fixtures/scored-scan/golden.json", import.meta.url),
  ).json();

describe("the candidate scan pages exactly as the recorded ranking does", () => {
  /**
   * `golden.json` was recorded from the scan before it could read scores:
   * pages, cursors, per-document breadth and snippets, the scan's own
   * report, and the exact rounds it asked the engine for. Both transports must
   * reproduce it, given the engine returns the same order through both.
   */
  test.each([
    ["native", NATIVE_SCAN_TRANSPORT],
    ["scored", SCORED],
  ] as const)("through the %s transport", async (name, transport) => {
    const { pages, endpoints } = await readFixtureSequence(transport);

    const recorded: unknown = structuredClone(pages);
    expect(recorded).toEqual(await readGolden());
    // Guard against a run that never reached the transport under test.
    expect([...endpoints]).toEqual([name]);
  });

  test("the fixture set covers every way a scan ends", async () => {
    const { pages } = await readFixtureSequence(NATIVE_SCAN_TRANSPORT);
    const all = Object.values(pages);

    expect(all.some((page) => page.scan.earlyStopped)).toBe(true);
    expect(all.some((page) => page.scan.roundCapHit)).toBe(true);
    expect(
      all.some((page) => !page.scan.earlyStopped && !page.scan.roundCapHit),
    ).toBe(true);
    expect(all.some((page) => page.nextCursor === null)).toBe(true);
    // A window the round cap moved on, which only a continuation replays.
    expect(all.some((page) => (page.nextCursor?.windowStart ?? 0) > 0)).toBe(
      true,
    );
    // Equal scores, so the engine's tie order is part of what is pinned.
    const scores = SCORED_SCAN_FIXTURES.flatMap((shape) =>
      buildCase(shape).passages.map((passage) => passage.score),
    );
    expect(new Set(scores).size).toBeLessThan(scores.length);
  });
});

describe("the scored transport", () => {
  const fixture = () =>
    buildCase({
      name: "shape",
      seed: 5,
      documents: 400,
      maxPassagesPerDocument: 6,
      limit: 10,
      granular: false,
    });

  test("asks for ids and scores only, a round at a time, in score order", async () => {
    await readFixturePage(fixture(), null, SCORED);

    const scan = engineRequests.filter((request) =>
      request.url.pathname.includes("/_elastic/"),
    );
    expect(scan.length).toBeGreaterThan(0);
    for (const [index, request] of scan.entries()) {
      expect(request.url.pathname).toBe(
        "/api/v1/_elastic/case_law_v5_cs_sk/_search",
      );
      expect(request.url.searchParams.get("_source_includes")).toBe(
        "document_id,chunk_id,anchor_id",
      );
      expect(request.body).toEqual({
        query: {
          query_string: { query: "text:fixture", default_operator: "AND" },
        },
        from: index * LIMITS.corpusIndexSearchCandidateLimit,
        size: LIMITS.corpusIndexSearchCandidateLimit,
        sort: [{ _score: { order: "desc" } }],
        track_total_hits: true,
      });
    }
    // Only the native passage batch and missing-passage fallbacks read text.
    const highlight = engineRequests.filter(
      (request) => request.body["snippet_fields"] !== undefined,
    );
    expect(highlight).toHaveLength(1);
    expect(highlight[0]?.url.pathname).toBe("/api/v1/case_law_v5_cs_sk/search");
  });

  test("reports the scores it read beside the page", async () => {
    const built = fixture();
    const page = await readFixturePage(built, null, SCORED);
    const scores = page.lexicalScores;
    if (scores === null) {
      throw new Error("the scored transport reported no scores");
    }

    const read = built.passages.slice(0, scores.nextOffset);
    expect(read.length).toBeGreaterThan(0);
    expect(scores.topScore).toBe(built.passages[0]?.score ?? null);
    expect(scores.lastScore).toBe(read.at(-1)?.score ?? null);
    expect(scores.totalHits).toBe(built.passages.length);
    // Best-first order, so a document's first passage is its best one.
    const firstSeen = new Map<string, number>();
    for (const passage of read) {
      if (!firstSeen.has(passage.document_id)) {
        firstSeen.set(passage.document_id, passage.score);
      }
    }
    expect([...scores.bestScoreById]).toEqual([...firstSeen]);
  });

  test("the native transport reports no scores", async () => {
    const page = await readFixturePage(fixture(), null, NATIVE_SCAN_TRANSPORT);

    expect(page.lexicalScores).toBeNull();
  });

  test("a hit without its stored fields fails the read rather than shortening the page", async () => {
    sourcelessRank = 3;

    const refused: unknown = await readFixturePage(
      fixture(),
      null,
      SCORED,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The same answer as any other malformed engine response: retryable, and
    // never a page that skipped the hit while still counting it as read.
    expect(refused).toBeInstanceOf(HandlerError);
    expect(refused).toMatchObject({ status: 503 });
  });

  test("a date order cannot be read through it", async () => {
    const refused: unknown = await readFixturePage(fixture(), null, SCORED, {
      type: "newest",
      timestampField: "decision_date_ts",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      message: expect.stringContaining(
        "A scored scan reads relevance order only",
      ),
    });
  });
});
