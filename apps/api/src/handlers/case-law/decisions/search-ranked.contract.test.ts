import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { SEARCH_PAGE_END, searchPageEnd } from "@stll/api-contract/search";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { searchCorpusIndexDecisions } from "@/api/handlers/case-law/decisions/search";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  corpusIndexGroupContractForJurisdiction,
  corpusIndexReadTarget,
} from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { buildCaseLawProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import { readCaseLawRankingSignals } from "@/api/lib/legal-search/corpus-index-projection-ranking-signals";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The decision-level search end to end: a v11 index in the engine, its
 * applied copies in Postgres, and the search handler between them.
 *
 * The case it exists for: a long question whose words no single passage
 * holds together. Required in one passage, as the passage generations require
 * them, nothing matches; ranked over the whole decision, the decision that
 * holds ten of the eleven words, spread over its passages, comes first, and
 * says which word it lacks.
 *
 * Opt-in: set STELLA_RUN_CORPUS_ENGINE_TESTS=true with the engine the q09
 * manifest pins serving the endpoints the test environment configures. The
 * suite creates and deletes its own index; Postgres is PGlite.
 */
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";

const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v11;
const GENERATION = MANIFEST.generation;
const INDEX_ID = `case_law_v11_ranked_${createSafeId<"corpusIndexProjectionIntent">().replaceAll("-", "")}`;
const ROUTED_INDEX_ID = corpusIndexId(GENERATION, "CZE");
const ENGINE_TIMEOUT_MS = 120_000;
const FINGERPRINT = "a".repeat(64);
const engine = getCorpusIndexClient("q09");
const sourceId = createSafeId<"caseLawSource">();

/** The question as a lawyer typed it. */
const QUESTION =
  "odklonil obchody jiné společnosti člen statutárního orgánu loajalita škoda ušlý zisk";

/** Filler that keeps each sentence in a passage of its own. */
const FILLER = "Soud se dále zabýval procesními otázkami řízení. ".repeat(40);

type Fixture = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  revision: SafeId<"corpusIndexProjectionIntent">;
  text: string;
};

const fixture = (
  caseNumber: string,
  sentences: readonly string[],
): Fixture => ({
  id: createSafeId<"caseLawDecision">(),
  caseNumber,
  revision: createSafeId<"corpusIndexProjectionIntent">(),
  text: sentences.map((sentence) => `${sentence} ${FILLER}`).join("\n\n"),
});

const FIXTURES = {
  /** Ten of the eleven words, never more than three in one passage. */
  tenOfEleven: fixture("27 Cdo 1/2026", [
    "Člen statutárního orgánu porušil povinnost.",
    "Uzavíral obchody pro jiné společnosti.",
    "Loajalita byla porušena a vznikla škoda.",
    "Společnosti ušlý zisk nebyl nahrazen.",
  ]),
  /** Three of the words. */
  threeWords: fixture("27 Cdo 2/2026", [
    "Škoda a ušlý zisk se posuzují samostatně.",
  ]),
  /** None of the words. */
  unrelated: fixture("27 Cdo 3/2026", ["Nájemní vztah skončil výpovědí."]),
} as const satisfies Record<string, Fixture>;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

const search = async (strict: boolean) => {
  const { indexGroup } = corpusIndexGroupContractForJurisdiction(
    MANIFEST,
    "CZE",
  );
  const resolution = corpusIndexReadTarget({
    manifest: MANIFEST,
    jurisdiction: "CZE",
    attestedGroups: new Set([indexGroup]),
    enrolledGroups: new Set([indexGroup]),
  });
  if (resolution.type !== "ready") {
    return panic("Expected the Czech corpus group to be ready");
  }
  const result = await searchCorpusIndexDecisions({
    body: { country: "CZE", query: QUESTION, strict, limit: 10 },
    caseLawDb,
    observer: "unobserved",
    dependencies: {
      configuredVariant: "off",
      loadCourtWeights: async () => courtWeightMapFromSeed(),
      readSourceRegistry: async () =>
        Result.ok({ excludedSourceIds: [], nameById: new Map() }),
      readServingTarget: async () =>
        Result.ok({
          ...resolution.target,
          route: { ...resolution.target.route, indexId: INDEX_ID },
          manifest: MANIFEST,
          serving: {
            family: "case_law",
            generation: GENERATION,
            cluster: MANIFEST.cluster,
          },
        }),
    },
  });
  if (!("hits" in result)) {
    return panic("Expected a successful indexed search page");
  }
  return result;
};

const pageEnd = (result: Awaited<ReturnType<typeof search>>) =>
  searchPageEnd({
    nextCursor: result.nextCursor,
    reach: result.pageReach,
    paginationOutcome: result.paginationOutcome,
  });

describe.skipIf(!runEngineTests)(
  "the decision-level search against the engine",
  () => {
    // timeout: builds the PGlite schema, then creates and fills the index.
    beforeAll(async () => {
      client = await createTestPglite();
      const db = drizzle({ client });
      const readDb = async <T>(
        fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
      ) =>
        await withPublicLawReaderRole(db, async (roleTx) => {
          const adaptedTx = {
            select: roleTx.select.bind(roleTx),
            query: roleTx.query,
            execute: async (
              statement: Parameters<typeof roleTx.execute>[0],
            ) => {
              const executed = await roleTx.execute(statement);
              return Object.assign(executed.rows, { rows: executed.rows });
            },
          };
          return await fn(asTestRaw<CaseLawPublicReadTransaction>(adaptedTx));
        });
      caseLawDb = asTestRaw<CaseLawPublicReadDb>(readDb);
      await client.exec(
        "CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)",
      );

      const fixtures = Object.values(FIXTURES);
      await db
        .insert(caseLawSources)
        .values([
          caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
        ]);
      await db.insert(caseLawDecisions).values(
        fixtures.map((entry) => ({
          id: entry.id,
          sourceId,
          caseNumber: entry.caseNumber,
          court: "Nejvyšší soud",
          country: "CZE",
          language: "cs",
          contentHash: "ranked",
        })),
      );
      await db.insert(corpusIndexGenerations).values({
        family: "case_law",
        generation: GENERATION,
        cluster: MANIFEST.cluster,
        manifestDigest: corpusIndexManifestDigest(MANIFEST),
        status: "building",
      });
      const signals = await db.transaction(
        async (tx) =>
          await readCaseLawRankingSignals(
            asTestRaw<Transaction>(tx),
            fixtures.map(({ id }) => id),
          ),
      );
      const documents = fixtures.flatMap((entry) =>
        buildCaseLawProjectionDocuments({
          manifest: MANIFEST,
          input: {
            family: "case_law",
            documentId: entry.id,
            sourceId,
            jurisdiction: "CZE",
            language: "cs",
            documentType: null,
            contentHash: "ranked",
            redistributionEligible: true,
            redacted: false,
            listingOnly: false,
            provisionKeys: [],
            rankingSignals:
              signals.get(entry.id) ?? panic("No signals for a fixture"),
            vacatedFrom: null,
            caseNumber: entry.caseNumber,
            identifiers: [],
            court: "Nejvyšší soud",
            courtId: null,
            decisionDate: null,
            ecli: null,
            metadata: null,
          },
          payload: { text: entry.text, ast: null },
          revision: entry.revision,
        }),
      );
      // The case the search exists for: the words are spread over passages.
      expect(
        documents.filter(
          ({ document_id }) => document_id === FIXTURES.tenOfEleven.id,
        ).length,
      ).toBeGreaterThan(1);
      const appliedAt = new Date("2026-11-01T00:00:00.000Z");
      await db.insert(corpusIndexProjectionIntents).values(
        fixtures.map((entry) => ({
          id: entry.revision,
          family: "case_law" as const,
          generation: GENERATION,
          entityId: entry.id,
          epoch: 1n,
          fingerprint: FINGERPRINT,
          indexId: ROUTED_INDEX_ID,
          appendStartedAt: appliedAt,
          appendCommittedAt: appliedAt,
          expectedDocumentCount: documents.filter(
            ({ document_id }) => document_id === entry.id,
          ).length,
          appliedAt,
          status: "applied" as const,
        })),
      );
      await db.insert(corpusIndexProjectionStates).values(
        fixtures.map((entry) => ({
          family: "case_law" as const,
          generation: GENERATION,
          entityId: entry.id,
          desiredAction: "upsert" as const,
          desiredEpoch: 1n,
          desiredFingerprint: FINGERPRINT,
          desiredIndexId: ROUTED_INDEX_ID,
          appliedAction: "upsert" as const,
          appliedEpoch: 1n,
          appliedRevision: entry.revision,
          appliedFingerprint: FINGERPRINT,
          appliedIndexId: ROUTED_INDEX_ID,
          appliedAt,
        })),
      );
      resetPublicCaseLawConfigForTesting(caseLawDb);

      const created = await engine.createIndex(
        corpusIndexConfigFromManifest(MANIFEST, INDEX_ID),
        "unobserved",
      );
      if (created.isErr()) {
        throw created.error;
      }
      const mutationBase =
        envBase.CORPUS_INDEX_Q09_ENDPOINT ??
        envBase.CORPUS_INDEX_Q09_SEARCH_ENDPOINT;
      const response = await fetch(
        `${String(mutationBase)}/api/v1/${INDEX_ID}/ingest?commit=force`,
        {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          body: `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`,
          signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new Error(`ingest ${String(response.status)}`);
      }
    }, ENGINE_TIMEOUT_MS);

    // timeout: deletes the index the engine holds.
    afterAll(async () => {
      const deleted = await engine.deleteIndex(INDEX_ID, "unobserved");
      await client.close();
      if (deleted.isErr()) {
        throw deleted.error;
      }
    }, ENGINE_TIMEOUT_MS);

    // timeout: one search is real engine round trips plus PGlite reads.
    test(
      "the decision holding ten of eleven words comes first and names the one it lacks",
      async () => {
        const result = await search(false);
        const first = result.hits.at(0);
        expect(first?.decisionId).toBe(FIXTURES.tenOfEleven.id);
        expect(first?.missingTerms).toEqual(["odklonil"]);
        expect(first?.matchedTerms).toHaveLength(
          result.queryUsed.split(" ").length - 1,
        );
        expect(first?.match).toBe("some_terms");
        // Fewer words, ranked lower; no word, not ranked at all.
        expect(result.hits.map(({ decisionId }) => decisionId)).toEqual([
          FIXTURES.tenOfEleven.id,
          FIXTURES.threeWords.id,
        ]);
        expect(result.hits.at(1)?.matchedTerms).toEqual([
          "škoda",
          "ušlý",
          "zisk",
        ]);
        // One ranked query: no second pass, and nothing it could leave unread.
        expect(result.paginationOutcome).toEqual({ type: "complete" });
        expect(pageEnd(result)).toBe(SEARCH_PAGE_END.COMPLETE);
        // No decision holds every word: the counts say which word is rare.
        expect(result.termDecisionCounts?.allTerms).toBe(0);
        expect(
          result.termDecisionCounts?.terms.find(
            ({ term }) => term === "odklonil",
          )?.count,
        ).toBe(0);
        expect(
          result.termDecisionCounts?.terms.find(({ term }) => term === "zisk")
            ?.count,
        ).toBe(2);
      },
      ENGINE_TIMEOUT_MS,
    );

    // timeout: one search is real engine round trips plus PGlite reads.
    test(
      "strict asks for every word anywhere in the decision",
      async () => {
        const result = await search(true);
        expect(result.hits).toEqual([]);
        expect(pageEnd(result)).toBe(SEARCH_PAGE_END.COMPLETE);
        expect(result.warnings.map(({ code }) => code)).toContain("no_hits");
      },
      ENGINE_TIMEOUT_MS,
    );
  },
);
