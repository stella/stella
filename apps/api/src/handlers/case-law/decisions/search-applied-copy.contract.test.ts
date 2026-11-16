import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

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
import { corpusIndexReadTarget } from "@/api/lib/legal-search/corpus-index-group-contract";
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
 * An indexed case-law search against the engine itself, with copies in the
 * index Postgres does not record as applied: the copy a refresh superseded,
 * a newer copy whose revision was never applied, the applied copy of a
 * decision whose erasure is queued, and a copy of a decision no state records
 * at all. The engine answers for every one of them until its deletes settle;
 * the search must rank and show only what Postgres serves.
 *
 * Opt-in: set STELLA_RUN_CORPUS_ENGINE_TESTS=true with the engine the q09
 * manifest pins serving the endpoints the test environment configures. The
 * suite creates and deletes its own index; Postgres is PGlite.
 */
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";

const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v10;
const GENERATION = MANIFEST.generation;
const INDEX_ID = `case_law_v10_applied_copy_${createSafeId<"corpusIndexProjectionIntent">().replaceAll("-", "")}`;
/** The index Postgres routes Czech decisions to; the engine's is redirected. */
const ROUTED_INDEX_ID = corpusIndexId(GENERATION, "CZE");
const ENGINE_TIMEOUT_MS = 120_000;
const FINGERPRINT = "a".repeat(64);
const COMMON = "spolecneslovo";
const engine = getCorpusIndexClient("q09");
const sourceId = createSafeId<"caseLawSource">();

type Revision = SafeId<"corpusIndexProjectionIntent">;

/** What Postgres records for a decision in the serving generation. */
type StateShape =
  | { type: "applied"; revision: Revision }
  | { type: "erasing"; revision: Revision }
  | { type: "none" };

type Fixture = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  /** Every copy the engine holds, by revision. */
  copies: { revision: Revision; text: string }[];
  state: StateShape;
};

const revision = () => createSafeId<"corpusIndexProjectionIntent">();
/** A passage that outranks the plain ones for the common word. */
const strong = (word: string) => `${`${COMMON} `.repeat(8)}${word}`;
const plain = `${COMMON} aktualniobsah`;

const servedRevision = revision();
const supersededRevision = revision();
const supersedingRevision = revision();
const appliedOlderRevision = revision();
const unappliedNewerRevision = revision();
const erasingRevision = revision();
const orphanRevision = revision();

const FIXTURES = {
  served: {
    id: createSafeId<"caseLawDecision">(),
    caseNumber: "1 Cdo 1/2026",
    copies: [{ revision: servedRevision, text: plain }],
    state: { type: "applied", revision: servedRevision },
  },
  superseded: {
    id: createSafeId<"caseLawDecision">(),
    caseNumber: "2 Cdo 2/2026",
    copies: [
      { revision: supersededRevision, text: strong("zastaralyslovo") },
      { revision: supersedingRevision, text: plain },
    ],
    state: { type: "applied", revision: supersedingRevision },
  },
  unappliedNewer: {
    id: createSafeId<"caseLawDecision">(),
    caseNumber: "3 Cdo 3/2026",
    copies: [
      { revision: appliedOlderRevision, text: plain },
      { revision: unappliedNewerRevision, text: strong("novyslovo") },
    ],
    state: { type: "applied", revision: appliedOlderRevision },
  },
  erasing: {
    id: createSafeId<"caseLawDecision">(),
    caseNumber: "4 Cdo 4/2026",
    copies: [{ revision: erasingRevision, text: strong("vymazaneslovo") }],
    state: { type: "erasing", revision: erasingRevision },
  },
  neverApplied: {
    id: createSafeId<"caseLawDecision">(),
    caseNumber: "5 Cdo 5/2026",
    copies: [{ revision: orphanRevision, text: strong("nikdyslovo") }],
    state: { type: "none" },
  },
} as const satisfies Record<string, Fixture>;

const SERVED_IDS = new Set<string>([
  FIXTURES.served.id,
  FIXTURES.superseded.id,
  FIXTURES.unappliedNewer.id,
]);

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

const search = async (query: string, limit: number, cursor?: string) => {
  const resolution = corpusIndexReadTarget({
    manifest: MANIFEST,
    jurisdiction: "CZE",
    attestedGroups: new Set(["cs_sk"]),
    enrolledGroups: new Set(["cs_sk"]),
  });
  if (resolution.type !== "ready") {
    return panic("Expected the Czech corpus group to be ready");
  }
  const result = await searchCorpusIndexDecisions({
    body: {
      country: "CZE",
      query,
      strict: true,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    },
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

describe.skipIf(!runEngineTests)(
  "an indexed search against the engine ranks only the copies Postgres applied",
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
              // Public SQL readers accept postgres-js arrays and PGlite's rows envelope.
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
        fixtures.map((fixture) => ({
          id: fixture.id,
          sourceId,
          caseNumber: fixture.caseNumber,
          court: "Nejvyšší soud",
          country: "CZE",
          language: "cs",
          contentHash: "applied-copy",
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
      const appliedAt = new Date("2026-11-01T00:00:00.000Z");
      const documents = fixtures.flatMap((fixture) =>
        fixture.copies.flatMap((copy) =>
          buildCaseLawProjectionDocuments({
            manifest: MANIFEST,
            input: {
              family: "case_law",
              documentId: fixture.id,
              sourceId,
              jurisdiction: "CZE",
              language: "cs",
              documentType: null,
              contentHash: "applied-copy",
              redistributionEligible: true,
              redacted: false,
              listingOnly: false,
              provisionKeys: [],
              rankingSignals:
                signals.get(fixture.id) ?? panic("No signals for a fixture"),
              vacatedFrom: null,
              caseNumber: fixture.caseNumber,
              identifiers: [],
              court: "Nejvyšší soud",
              courtId: null,
              decisionDate: null,
              ecli: null,
              metadata: null,
            },
            payload: { text: copy.text, ast: null },
            revision: copy.revision,
          }),
        ),
      );
      const recorded = fixtures.flatMap((fixture) =>
        fixture.state.type === "none"
          ? []
          : [{ fixture, state: fixture.state }],
      );
      await db.insert(corpusIndexProjectionIntents).values(
        recorded.map(({ fixture, state }) => ({
          id: state.revision,
          family: "case_law" as const,
          generation: GENERATION,
          entityId: fixture.id,
          epoch: 1n,
          fingerprint: FINGERPRINT,
          indexId: ROUTED_INDEX_ID,
          status: "applied" as const,
          appendStartedAt: appliedAt,
          appendCommittedAt: appliedAt,
          expectedDocumentCount: 1,
          appliedAt,
        })),
      );
      await db.insert(corpusIndexProjectionStates).values(
        recorded.map(({ fixture, state }) => ({
          family: "case_law" as const,
          generation: GENERATION,
          entityId: fixture.id,
          ...(state.type === "erasing"
            ? {
                desiredAction: "erase" as const,
                desiredEpoch: 2n,
                desiredFingerprint: null,
                desiredIndexId: null,
              }
            : {
                desiredAction: "upsert" as const,
                desiredEpoch: 1n,
                desiredFingerprint: FINGERPRINT,
                desiredIndexId: ROUTED_INDEX_ID,
              }),
          appliedAction: "upsert" as const,
          appliedEpoch: 1n,
          appliedRevision: state.revision,
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

    // timeout: each search is real engine round trips plus PGlite reads.
    test.each([
      { copy: "a superseded copy", word: "zastaralyslovo" },
      { copy: "a newer copy never applied", word: "novyslovo" },
      { copy: "the copy of a decision being erased", word: "vymazaneslovo" },
      { copy: "a copy no state records", word: "nikdyslovo" },
    ])(
      "a word only $copy holds finds nothing",
      async ({ word }) => {
        const page = await search(word, 10);
        expect(page.hits.map(({ decisionId }) => decisionId)).toEqual([]);
      },
      ENGINE_TIMEOUT_MS,
    );

    // timeout: real engine round trips plus PGlite reads.
    test(
      "the common word finds every served decision, each excerpted from its applied copy",
      async () => {
        const page = await search(COMMON, 10);
        expect(new Set(page.hits.map(({ decisionId }) => decisionId))).toEqual(
          SERVED_IDS,
        );
        for (const hit of page.hits) {
          expect(hit.headline).not.toBeNull();
          expect(hit.headline ?? "").not.toMatch(
            /zastaralyslovo|novyslovo|vymazaneslovo|nikdyslovo/u,
          );
        }
      },
      ENGINE_TIMEOUT_MS,
    );

    // timeout: up to four pages, each real engine round trips.
    test(
      "one decision per page: no page is spent on a copy Postgres does not serve",
      async () => {
        // The unserved copies outrank every served one for the common word,
        // so a ranking that stood on them would cut pages it then had to
        // empty.
        const chain: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          // Each page needs the previous page's cursor.
          const read = await search(COMMON, 1, cursor);
          const ids = read.hits.map(({ decisionId }) => decisionId);
          if (read.nextCursor === null) {
            chain.push(...ids);
            break;
          }
          expect(ids).toHaveLength(1);
          chain.push(...ids);
          cursor = read.nextCursor;
        }
        expect(chain.toSorted()).toEqual([...SERVED_IDS].toSorted());
      },
      ENGINE_TIMEOUT_MS,
    );
  },
);
