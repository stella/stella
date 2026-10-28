import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawMatterLinks,
  caseLawSourceArrivals,
  caseLawSources,
} from "@/api/db/schema";
import { recomputeCitationAuthorityBatch } from "@/api/handlers/case-law/citation-authority";
import { listIncomingDecisionCitations } from "@/api/handlers/case-law/decisions/citations";
import { readCaseLawArrivalsQuery } from "@/api/handlers/case-law/decisions/coverage-arrivals";
import { readLatestDecisionsByCourt } from "@/api/handlers/case-law/decisions/latest";
import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import { caseLawSearchPlan } from "@/api/handlers/case-law/decisions/search";
import { readCaseLawCorpusStatusQuery } from "@/api/handlers/case-law/decisions/status";
import { readCaseLawCourtActivityQuery } from "@/api/handlers/case-law/decisions/status-courts";
import { listMatterLinksHandler } from "@/api/handlers/case-law/matter-links/list";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readDecisionWork } from "@/api/lib/case-law/decision-work";
import {
  CASE_LAW_SURFACE_COUNTRIES,
  withRedistributableSubject,
} from "@/api/lib/case-law/public-subject";
import { sourceArrivalsRefreshQuery } from "@/api/lib/case-law/source-arrivals-refresh";
import { executedRows } from "@/api/lib/db/executed-rows";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";
import { pgFtsBrowseFacetPublishedQuery } from "@/api/lib/legal-search/pg-fts-browse-facet-refresh";
import { readPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facets";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  caseLawPublishedDecisionsFixtureSql,
  caseLawUnredactedDecisionsFixtureSql,
} from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const INGESTED_AT = new Date("2026-10-11T11:00:00.000Z");
const COURT = "Publication filter court";
const LANGUAGE_GROUP = "ECLI:CZ:NS:2026:PUBLICATION.FILTER";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
if (!databaseUrl || !runPostgresTests) {
  describe.skip("public reads use the publication filter (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  test("public read paths use the publication filter", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      await db.transaction(async (tx) => {
        // db-await-in-loop: create each fixed temp relation on the transaction's connection.
        for (const table of [
          "case_law_sources",
          "case_law_decisions",
          "case_law_citations",
          "case_law_search_documents",
          "case_law_decision_identifiers",
          "case_law_browse_facet_counts",
          "case_law_source_arrivals",
          "case_law_matter_links",
        ]) {
          await tx.execute(
            sql.raw(`CREATE TEMP TABLE ${table} (
            LIKE public.${table} INCLUDING DEFAULTS
          ) ON COMMIT DROP`),
          );
        }
        await tx.execute(caseLawPublishedDecisionsFixtureSql);
        await tx.execute(caseLawUnredactedDecisionsFixtureSql);

        const sourceId = createSafeId<"caseLawSource">();
        const decisionId = createSafeId<"caseLawDecision">();
        const citingId = createSafeId<"caseLawDecision">();
        const listingOnlyId = createSafeId<"caseLawDecision">();
        const redactedId = createSafeId<"caseLawDecision">();
        await tx.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: "publication-filter-test",
          name: "Publication filter test",
        });
        await tx.insert(caseLawSourceArrivals).values({
          sourceId,
          addedLastWeek: 2,
          countedAt: NOW,
        });
        await tx.insert(caseLawDecisions).values([
          {
            id: decisionId,
            sourceId,
            caseNumber: "public decision",
            court: COURT,
            country: "CZE",
            language: "cs",
            languageGroupKey: LANGUAGE_GROUP,
            metadata: {},
            createdAt: INGESTED_AT,
            updatedAt: NOW,
            decisionDate: "2026-10-10",
          },
          {
            id: citingId,
            sourceId,
            caseNumber: "public citing decision",
            court: COURT,
            country: "CZE",
            language: "cs",
            metadata: {},
            createdAt: INGESTED_AT,
            updatedAt: NOW,
            decisionDate: "2026-10-10",
          },
          {
            id: listingOnlyId,
            sourceId,
            caseNumber: "listed decision",
            court: COURT,
            country: "CZE",
            language: "cs",
            languageGroupKey: LANGUAGE_GROUP,
            metadata: {
              _stellaPartialObservation: { isListingOnly: true },
            },
            createdAt: new Date("2026-10-11T09:00:00.000Z"),
            updatedAt: new Date("2026-10-12T08:00:00.000Z"),
            decisionDate: "2026-10-10",
          },
          {
            id: redactedId,
            sourceId,
            caseNumber: "unavailable decision",
            court: COURT,
            country: "CZE",
            language: "cs",
            languageGroupKey: LANGUAGE_GROUP,
            metadata: {},
            redactedAt: NOW,
            createdAt: new Date("2026-10-11T08:00:00.000Z"),
            updatedAt: new Date("2026-10-12T10:00:00.000Z"),
            decisionDate: "2026-10-10",
          },
        ]);
        const workspaceId = createSafeId<"workspace">();
        await tx.insert(caseLawMatterLinks).values(
          [decisionId, listingOnlyId, redactedId].map((linkedDecisionId) => ({
            id: createSafeId<"caseLawMatterLink">(),
            decisionId: linkedDecisionId,
            workspaceId,
            linkedBy: "publication-filter-test",
          })),
        );
        await tx.insert(caseLawCitations).values([
          {
            id: createSafeId<"caseLawCitation">(),
            citingDecisionId: citingId,
            citedDecisionId: decisionId,
            citationText: "public citation",
          },
          {
            id: createSafeId<"caseLawCitation">(),
            citingDecisionId: listingOnlyId,
            citedDecisionId: decisionId,
            citationText: "listed citation",
          },
          {
            id: createSafeId<"caseLawCitation">(),
            citingDecisionId: redactedId,
            citedDecisionId: decisionId,
            citationText: "unavailable citation",
          },
        ]);
        await tx.execute(sql`INSERT INTO case_law_search_documents
          (decision_id, searchable_text, language, regconfig, tsv)
          SELECT id, 'publicationword', 'cs', 'simple',
            to_tsvector('simple', 'publicationword')
          FROM case_law_decisions`);

        const caseLawDb = asTestRaw<CaseLawPublicReadDb>(
          async <Value>(
            read: (readerTx: CaseLawPublicReadTransaction) => Promise<Value>,
          ) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
        );
        const scopedDb = asTestRaw<ScopedDb>(
          async <Value>(
            read: (scopedTx: CaseLawPublicReadTransaction) => Promise<Value>,
          ) => await read(asTestRaw(tx)),
        );
        const country =
          publicCaseLawCountry("CZE") ??
          panic("CZE is a public case-law country");

        const matterLinks = await listMatterLinksHandler({
          caseLawDb,
          scopedDb,
          workspaceId,
        });
        expect(
          matterLinks.links.map(
            ({ decisionId: linkedDecisionId }) => linkedDecisionId,
          ),
        ).toEqual([decisionId]);

        const search = caseLawSearchPlan({
          body: { country: "CZE", query: "publicationword" },
          configs: [
            {
              regconfig: "simple",
              languages: ["cs"],
              includeDefault: false,
              useUnaccent: false,
            },
          ],
          courtWeights: new Map(),
          excerpt: DEFAULT_SEARCH_EXCERPT,
          limit: 10,
          parsedCursor: null,
          queryUsed: "publicationword",
          sort: DEFAULT_SEARCH_SORT,
        });
        const searchHits = executedRows(await tx.execute(search.hits)).map(
          (hit) => {
            if (!isRecord(hit)) {
              return panic("Expected a search hit row");
            }
            return hit;
          },
        );
        expect(
          searchHits
            .map((hit) => hit["decision_id"])
            .filter((id): id is string => typeof id === "string")
            .toSorted(),
        ).toEqual([decisionId, citingId].toSorted());
        const targetHit = searchHits.find(
          (hit) => hit["decision_id"] === decisionId,
        );
        expect(Number(targetHit?.["citation_count"])).toBe(1);
        expect(Number(targetHit?.["citation_authority"])).toBeGreaterThan(0);
        const searchFacets = executedRows(
          await tx.execute(search.facets.court),
        );
        expect(searchFacets).toContainEqual(
          expect.objectContaining({ value: COURT, count: 2 }),
        );

        const latest = await readLatestDecisionsByCourt({
          caseLawDb,
          country,
          courts: [{ court: COURT, tierLabel: "supreme" }],
        });
        expect(
          latest
            .flatMap((group) => group.decisions.map(({ id }) => id))
            .toSorted(),
        ).toEqual([decisionId, citingId].toSorted());

        const updatedAt = await caseLawDb(
          async (readerTx) =>
            await readCaseLawCorpusStatusQuery(readerTx, {
              country,
              excludedSourceIds: [],
            }),
        );
        expect(updatedAt).not.toBeNull();
        expect(new Date(updatedAt ?? "").toISOString()).toBe(NOW.toISOString());

        const activity = await caseLawDb(
          async (readerTx) =>
            await readCaseLawCourtActivityQuery(readerTx, {
              country,
              courts: [COURT],
              excludedSourceIds: [],
              now: new Date("2026-10-11T13:00:00.000Z"),
            }),
        );
        const courtActivity = activity.get(COURT);
        expect(courtActivity).toMatchObject({
          addedLastDay: 2,
          addedLastWeek: 2,
        });
        expect(new Date(courtActivity?.updatedAt ?? "").toISOString()).toBe(
          NOW.toISOString(),
        );

        const facets = await caseLawDb(
          async (readerTx) =>
            await readPgFtsBrowseFacets(readerTx, {
              excludedSourceIds: [],
              jurisdiction: "CZE",
              limit: 10,
            }),
        );
        expect(facets.court).toEqual([{ count: 2, value: COURT }]);

        const arrivals = executedRows(
          await tx.execute(sourceArrivalsRefreshQuery(NOW)),
        )
          .map((arrival) => {
            if (!isRecord(arrival)) {
              return panic("Expected a source arrivals row");
            }
            return arrival;
          })
          .at(0);
        expect(arrivals?.["added_last_week"]).toBe(2);
        const coverageArrivals = await caseLawDb(
          async (readerTx) =>
            await readCaseLawArrivalsQuery(readerTx, {
              sourceIds: [sourceId],
              now: NOW,
            }),
        );
        expect(coverageArrivals.get(sourceId)).toEqual({ addedLastWeek: 2 });

        const citations = await caseLawDb(
          async (readerTx) =>
            await listIncomingDecisionCitations({
              tx: readerTx,
              cursor: undefined,
              work: await readDecisionWork(readerTx, decisionId),
              countries: CASE_LAW_SURFACE_COUNTRIES.pages,
            }),
        );
        if (!("items" in citations)) {
          panic("Expected a citation page for a valid cursor");
        }
        expect(
          citations.items.map(({ citingDecisionId }) => citingDecisionId),
        ).toEqual([citingId]);

        const materialized = await recomputeCitationAuthorityBatch(tx, {
          after: null,
          limit: 10,
          now: { type: "pinned", at: NOW },
          courtWeightEntries: [],
        });
        expect(materialized.cited).toBe(1);
        const decisionCount = await tx
          .select({ citationCount: caseLawDecisions.citationCount })
          .from(caseLawDecisions)
          .where(sql`${caseLawDecisions.id} = ${decisionId}`);
        expect(decisionCount.at(0)?.citationCount).toBe(1);
        const latestAfterRecompute = await readLatestDecisionsByCourt({
          caseLawDb,
          country,
          courts: [{ court: COURT, tierLabel: "supreme" }],
        });
        expect(
          latestAfterRecompute
            .flatMap((group) => group.decisions)
            .find(({ id }) => id === decisionId)?.citationCount,
        ).toBe(1);

        expect(
          await withRedistributableSubject(
            caseLawDb,
            "pages",
            { kind: "id", id: redactedId },
            async (subject) => subject.id,
          ),
        ).toBeNull();
        expect(
          await withRedistributableSubject(
            caseLawDb,
            "pages",
            { kind: "id", id: listingOnlyId },
            async (subject) => subject.id,
          ),
        ).toBeNull();
        const reader = await readDecisionReaderSource({
          caseLawDb,
          decisionId: redactedId,
          surface: "pages",
          phase: "blocks",
          audience: "model",
        });
        expect(reader).toBeNull();
      });
    });
  }, 60_000);

  test("publication states determine public read membership", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      await db.transaction(async (tx) => {
        await tx.execute(sql`CREATE TEMP TABLE case_law_decisions (
          LIKE public.case_law_decisions INCLUDING DEFAULTS
        ) ON COMMIT DROP`);
        const states = [
          {
            kind: "published",
            visibility: true,
            metadata: {},
            redactedAt: null,
          },
          {
            kind: "listing-only",
            visibility: false,
            metadata: {
              _stellaPartialObservation: { isListingOnly: true },
            },
            redactedAt: null,
          },
          {
            kind: "erased",
            visibility: false,
            metadata: {},
            redactedAt: NOW,
          },
          {
            kind: "listing-only-and-erased",
            visibility: false,
            metadata: {
              _stellaPartialObservation: { isListingOnly: true },
            },
            redactedAt: NOW,
          },
        ] as const;
        const rows = states.map((state) => ({
          id: createSafeId<"caseLawDecision">(),
          sourceId: createSafeId<"caseLawSource">(),
          caseNumber: state.kind,
          court: COURT,
          country: "CZE",
          language: "cs",
          metadata: state.metadata,
          redactedAt: state.redactedAt,
        }));
        await tx.insert(caseLawDecisions).values(rows);

        await tx.execute(caseLawPublishedDecisionsFixtureSql);
        await tx.execute(caseLawUnredactedDecisionsFixtureSql);

        const publishedViewRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM case_law_published_decisions`,
        );
        const unredactedViewRows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM case_law_unredacted_decisions`,
        );
        expect(new Set(publishedViewRows.map(({ id }) => id))).toEqual(
          new Set(
            rows
              .filter((_, index) => states[index]?.visibility === true)
              .map(({ id }) => id),
          ),
        );
        expect(new Set(unredactedViewRows.map(({ id }) => id))).toEqual(
          new Set(
            rows.filter((row) => row.redactedAt === null).map(({ id }) => id),
          ),
        );

        const published = await pgFtsBrowseFacetPublishedQuery(tx);
        expect(new Set(published.map(({ sourceId }) => sourceId))).toEqual(
          new Set(
            rows
              .filter((_, index) => states[index]?.visibility === true)
              .map(({ sourceId }) => sourceId),
          ),
        );
      });
    });
  }, 120_000);
}
