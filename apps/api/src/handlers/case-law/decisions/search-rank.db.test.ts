import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { rehydrateCaseLawCandidates } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawCorpusDocumentCanRecur } from "@/api/lib/legal-search/case-law-corpus-projection";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  readCorpusIndexSearchPage,
  type SearchCursor,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  corpusSearchGroupToken,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import { LIMITS } from "@/api/lib/limits";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v5";
const FINGERPRINT = "a".repeat(64);
/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const sourceId = createSafeId<"caseLawSource">();
const supremeId = createSafeId<"caseLawDecision">();
const districtId = createSafeId<"caseLawDecision">();
const groupCsId = createSafeId<"caseLawDecision">();
const groupEnId = createSafeId<"caseLawDecision">();
const singletonId = createSafeId<"caseLawDecision">();
const originalFetch = globalThis.fetch;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

const rank = async (candidates: { id: string; score: number }[]) =>
  await rehydrateCaseLawCandidates({
    body: { country: "CZE", query: "search rank" },
    candidates,
    caseLawDb,
    courtWeights: courtWeightMapFromSeed(),
    generation: GENERATION,
  });

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db
      .insert(caseLawSources)
      .values([
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      ]);
    const indexed = { contentHash: "rank-hash" };
    const decisions = [
      {
        ...indexed,
        id: supremeId,
        sourceId,
        caseNumber: "23 Cdo 1/2026",
        // Published last week: nothing has had the chance to cite it.
        citationAuthority: 0,
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "rank-supreme",
      },
      {
        ...indexed,
        id: districtId,
        sourceId,
        caseNumber: "8 C 1/2019",
        // Cited, but lightly: the tier prior is deliberately small enough
        // that a decision the field actually relies on keeps its place.
        citationAuthority: 0.3,
        court: "Okresní soud v Kolíně",
        country: "CZE",
        language: "cs",
        languageGroupKey: "rank-district",
      },
      {
        ...indexed,
        id: groupCsId,
        sourceId,
        caseNumber: "SYN 2/2026 cs",
        citationAuthority: 0,
        court: "Synthetic court",
        country: "CZE",
        language: "cs",
        languageGroupKey: "rank-group",
      },
      {
        ...indexed,
        id: singletonId,
        sourceId,
        caseNumber: "SYN 3/2026",
        citationAuthority: 0,
        court: "Synthetic court",
        country: "CZE",
        language: "cs",
        languageGroupKey: null,
      },
      {
        ...indexed,
        id: groupEnId,
        sourceId,
        caseNumber: "SYN 2/2026 en",
        citationAuthority: 4,
        court: "Synthetic court",
        country: "CZE",
        language: "en",
        languageGroupKey: "rank-group",
      },
    ];
    await db.insert(caseLawDecisions).values(decisions);

    await db.insert(corpusIndexGenerations).values({
      family: "case_law",
      generation: GENERATION,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[GENERATION],
      ),
      status: "building",
    });
    // Rehydration serves a decision only where this generation has applied
    // what it wants, in the index the decision's country routes to, so the
    // held rows derive that country from the decision instead of repeating it.
    const appliedAt = new Date();
    const held = decisions.map(({ country, id }) => ({
      entityId: id,
      indexId: corpusIndexId(GENERATION, country),
      intentId: createSafeId<"corpusIndexProjectionIntent">(),
    }));
    await db.insert(corpusIndexProjectionIntents).values(
      held.map(({ entityId, indexId, intentId }) => ({
        id: intentId,
        family: "case_law" as const,
        generation: GENERATION,
        entityId,
        epoch: 1n,
        fingerprint: FINGERPRINT,
        indexId,
        status: "applied" as const,
        appendStartedAt: appliedAt,
        appendCommittedAt: appliedAt,
        expectedDocumentCount: entityId === districtId ? 3 : 1,
        appliedAt,
      })),
    );
    await db.insert(corpusIndexProjectionStates).values(
      held.map(({ entityId, indexId, intentId }) => ({
        family: "case_law" as const,
        generation: GENERATION,
        entityId,
        desiredAction: "upsert" as const,
        desiredEpoch: 1n,
        desiredFingerprint: FINGERPRINT,
        desiredIndexId: indexId,
        appliedAction: "upsert" as const,
        appliedEpoch: 1n,
        appliedRevision: intentId,
        appliedFingerprint: FINGERPRINT,
        appliedIndexId: indexId,
        appliedAt,
      })),
    );
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("only recurrent decisions consume the carried group budget", async () => {
  const { groups, ranked } = await rank([
    { id: supremeId, score: 0.5 },
    { id: districtId, score: 0.5 },
    { id: singletonId, score: 0.5 },
    { id: groupCsId, score: 0.5 },
  ]);
  expect(ranked).toHaveLength(4);
  expect(new Set(groups)).toEqual(
    new Set([
      corpusSearchGroupToken("language:rank-district"),
      corpusSearchGroupToken("language:rank-group"),
    ]),
  );
});

test("a missing applied passage count cannot prove a singleton", async () => {
  const rows = await caseLawDb(
    async (tx) =>
      await tx
        .select({
          canRecur: caseLawCorpusDocumentCanRecur("missing-generation"),
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, singletonId)),
  );
  expect(rows).toEqual([{ canRecur: true }]);
});

test("a fresh supreme decision outranks an equally matching cited district one", async () => {
  const { ranked } = await rank([
    { id: districtId, score: 0.5 },
    { id: supremeId, score: 0.5 },
  ]);

  expect(ranked.map((hit) => hit.id)).toEqual([supremeId, districtId]);
  // The district decision keeps the authority it earned; the tier prior is
  // what the fresh apex decision has instead.
  expect(ranked.at(-1)?.citationAuthority).toBe(0.3);
});

test("a stronger lexical match outranks the higher court", async () => {
  const { ranked } = await rank([
    { id: districtId, score: 0.95 },
    { id: supremeId, score: 0.5 },
  ]);

  expect(ranked.map((hit) => hit.id)).toEqual([districtId, supremeId]);
});

test("the language versions of one judgment are a single hit, ranked by the best", async () => {
  // The Czech version matches the entry better; the English one is the cited
  // record. Blending before the fold is what lets the second stand for both.
  const { ranked } = await rank([
    { id: groupCsId, score: 0.6 },
    { id: groupEnId, score: 0.55 },
  ]);

  expect(ranked.map((hit) => hit.id)).toEqual([groupEnId]);

  const groupOnly = await rank([{ id: groupCsId, score: 0.6 }]);
  expect(groupOnly.ranked.map((hit) => hit.id)).toEqual([groupCsId]);
});

test("ranking one candidate set twice yields the same order", async () => {
  const candidates = [
    { id: districtId, score: 0.5 },
    { id: supremeId, score: 0.5 },
    { id: groupEnId, score: 0.5 },
  ];
  const first = await rank(candidates);
  const again = await rank(candidates.toReversed());

  expect(again.ranked.map((hit) => hit.id)).toEqual(
    first.ranked.map((hit) => hit.id),
  );
});

test.each(
  ["ordinary", "capped"].flatMap((mode) =>
    [1, 2, 3].map((limit) => ({ mode, limit })),
  ),
)(
  "$mode case-law cursor walk returns every judgment once at limit $limit",
  async ({ mode, limit }) => {
    const reachable =
      LIMITS.corpusIndexSearchMaxRounds *
      LIMITS.corpusIndexSearchCandidateLimit;
    // The later English sibling wins a fresh ranking. Both it and the
    // ungrouped singleton must stay excluded after the window advances.
    const ids =
      mode === "capped"
        ? [
            groupCsId,
            singletonId,
            ...Array.from({ length: reachable - 2 }, () => groupCsId),
            groupEnId,
            singletonId,
            supremeId,
            districtId,
          ]
        : [groupCsId, singletonId, groupEnId, supremeId, districtId];
    const engineHits = ids.map((id, index) => ({
      document_id: id,
      chunk_id: `passage-${index}`,
    }));
    // The applied census must describe the physical passages this engine emits.
    const passageCounts = new Map<string, number>();
    for (const id of ids) {
      passageCounts.set(id, (passageCounts.get(id) ?? 0) + 1);
    }
    await drizzle({ client }).execute(sql`
      UPDATE ${corpusIndexProjectionIntents} intent
      SET expected_document_count = census.passage_count
      FROM (VALUES ${sql.join(
        [...passageCounts].map(
          ([id, count]) => sql`(${id}::uuid, ${count}::int)`,
        ),
        sql`, `,
      )}) AS census(entity_id, passage_count)
      WHERE intent.family = 'case_law'
        AND intent.generation = ${GENERATION}
        AND intent.entity_id = census.entity_id
    `);
    const stub = async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const body: Record<string, unknown> =
        typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const offset = Number(body["start_offset"] ?? 0);
      return new Response(
        JSON.stringify({
          num_hits: engineHits.length,
          hits: engineHits.slice(offset, offset + Number(body["max_hits"])),
          snippets: [],
        }),
        { status: 200 },
      );
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });

    const seen: string[] = [];
    let cursor: SearchCursor | null = null;
    let finished = false;
    let windowMoved = false;
    const readPage = async (parsedCursor: SearchCursor | null) =>
      await readCorpusIndexSearchPage({
        observer: "unobserved",
        cluster: "q09",
        indexId: corpusIndexId(GENERATION, "CZE"),
        query: "text:rank",
        limit,
        parsedCursor,
        order: RELEVANCE_ORDER,
        snippetFields: [],
        extractId: (hit) =>
          typeof hit["document_id"] === "string" ? hit["document_id"] : null,
        extractSnippet: () => null,
        // Force the scan to reach either exhaustion or its round cap.
        unseenScoreUpperBound: (score) => score + 1,
        rankCandidates: async (candidates) =>
          await rehydrateCaseLawCandidates({
            body: { country: "CZE", query: "search rank" },
            candidates,
            caseLawDb,
            courtWeights: courtWeightMapFromSeed(),
            generation: GENERATION,
            excludedGroups: new Set(parsedCursor?.excludedGroups),
          }),
      });
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await readPage(cursor);
      expect(page.pageRanked.length).toBeLessThanOrEqual(limit);
      if (pageIndex === 0) {
        expect(page.scan.roundCapHit).toBe(mode === "capped");
      }
      seen.push(
        ...page.pageRanked.map((hit) =>
          hit.id === groupCsId || hit.id === groupEnId ? "rank-group" : hit.id,
        ),
      );
      if (page.nextCursor === null) {
        finished = true;
        break;
      }
      windowMoved ||= page.nextCursor.windowStart === reachable;
      const wire = encodeCorpusSearchCursor({
        ...page.nextCursor,
        dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
        target: null,
      });
      const decoded = decodeCorpusSearchCursor(wire);
      expect(decoded).not.toBeNull();
      expect(decoded?.excludedGroups).toEqual(page.nextCursor.excludedGroups);
      cursor = decoded;
    }

    expect(finished).toBe(true);
    expect(windowMoved).toBe(mode === "capped");
    expect(seen).toHaveLength(new Set(seen).size);
    expect(seen.toSorted()).toEqual(
      ["rank-group", singletonId, supremeId, districtId].toSorted(),
    );
  },
);
