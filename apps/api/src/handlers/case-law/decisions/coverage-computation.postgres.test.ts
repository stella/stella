import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getViewConfig, PgDialect } from "drizzle-orm/pg-core";

import { CZ_ECLI_COURT_REGISTRY } from "@stll/api-contract/case-law-courts";

import {
  caseLawBrowseFacetCounts,
  caseLawCourtWeights,
  caseLawDecisions,
  caseLawSourceArrivals,
  caseLawSources,
  publishedCaseLawDecisions,
  unredactedCaseLawDecisions,
} from "@/api/db/schema";
import {
  CASE_LAW_COVERAGE_AVAILABILITY,
  computeCaseLawCoverageAnswer,
} from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT } from "@/api/lib/decision-date-bounds-sql";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { refreshPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facet-refresh";
import { LIMITS } from "@/api/lib/limits";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("coverage computation (postgres)", () => {
  // timeout: exercise the complete coverage read against migrated PostgreSQL.
  test("source court totals and valid year bounds share one held connection", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("The enabled coverage computation test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const schemaName = `coverage_computation_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      resetPublicCaseLawConfigForTesting(
        asTestRaw<CaseLawPublicReadDb>(async () =>
          panic("Coverage must read court weights on its held transaction"),
        ),
      );
      try {
        for (const table of [
          "case_law_sources",
          "case_law_source_arrivals",
          "case_law_decisions",
          "case_law_search_documents",
          "case_law_browse_facet_counts",
          "case_law_court_weights",
        ]) {
          // db-await-in-loop: clone the finite migrated corpus fixture.
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
        await db.execute(sql`ALTER TABLE ${schema}.case_law_decisions
          DROP CONSTRAINT IF EXISTS ${sql.identifier(CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT)}`);
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL search_path TO ${schema}, public`);
          const dialect = new PgDialect();
          for (const view of [
            publishedCaseLawDecisions,
            unredactedCaseLawDecisions,
          ]) {
            const config = getViewConfig(view);
            const rendered = dialect.sqlToQuery(config.query);
            // db-await-in-loop: bind each production view to the isolated corpus.
            await tx.execute(sql`CREATE VIEW ${schema}.${sql.identifier(config.name)}
              AS (${sql.raw(rendered.sql)})`);
          }
          const sourceId = createSafeId<"caseLawSource">();
          const decisionId = createSafeId<"caseLawDecision">();
          await tx.insert(caseLawSources).values(
            caseLawSourceRow({
              id: sourceId,
              adapterKey: ADAPTER_KEYS.CZ_NS,
              storedTotal: 1,
              storedTotalAsOf: new Date(),
            }),
          );
          await tx
            .insert(caseLawSourceArrivals)
            .values({ sourceId, addedLastWeek: 7, countedAt: new Date() });
          await tx.insert(caseLawDecisions).values({
            id: decisionId,
            sourceId,
            country: "CZE",
            language: "cs",
            court: "Nejvyšší soud",
            caseNumber: "Coverage computation fixture",
            decisionDate: "2026-01-01",
            fulltext: "Published decision text",
          });
          await tx.execute(sql`INSERT INTO case_law_search_documents
            (decision_id, language, regconfig, searchable_text, tsv)
            VALUES (${decisionId}, 'cs', 'simple', 'Published decision text',
              to_tsvector('simple', 'Published decision text'))`);
          await tx.insert(caseLawCourtWeights).values({
            country: "CZE",
            courtPattern: "^Nejvyšší soud$",
            tier: 3,
            tierLabel: "supreme",
            weight: 1,
          });

          const { answer, complete } = await computeCaseLawCoverageAnswer(
            async (read) => await read(tx),
            [],
          );
          expect(complete).toBe(true);
          if ("message" in answer) {
            panic("The fixture must produce a coverage answer");
          }
          expect(answer.totals.searchable).toBe(1);
          expect(answer.totals.addedLastWeek).toBe(7);
          const coverageCountry = answer.countries.find(
            ({ country }) => country === "CZE",
          );
          expect(coverageCountry?.availability).toBe(
            CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE,
          );
          if (
            coverageCountry?.availability !==
            CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE
          ) {
            panic("The fixture country must be searchable");
          }
          expect(coverageCountry.searchable).toBe(1);
          expect(
            coverageCountry.sources.map(({ adapterKey }) => adapterKey),
          ).toEqual([ADAPTER_KEYS.CZ_NS]);
          expect(coverageCountry.courts).toEqual([
            expect.objectContaining({
              type: "court",
              court: "Nejvyšší soud",
              tier: "supreme",
              decisions: 1,
            }),
          ]);

          const multiCourtSourceId = createSafeId<"caseLawSource">();
          const undatedSourceId = createSafeId<"caseLawSource">();
          const emptySourceId = createSafeId<"caseLawSource">();
          await tx.insert(caseLawSources).values([
            caseLawSourceRow({
              id: emptySourceId,
              adapterKey: ADAPTER_KEYS.CZ_US,
            }),
            caseLawSourceRow({
              id: multiCourtSourceId,
              adapterKey: ADAPTER_KEYS.CZ_NSS,
              storedTotal: 50,
              storedTotalAsOf: new Date(),
            }),
            caseLawSourceRow({
              id: undatedSourceId,
              adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
            }),
          ]);
          expect(
            Object.values(CZ_ECLI_COURT_REGISTRY).map(({ name }) => name),
          ).not.toContain("Okresní soud v Benešově");
          const datedRows = [
            {
              court: "Nejvyšší správní soud",
              decisionDate: "1872-06-15",
              caseNumber: "7 Co 91/2022",
            },
            {
              court: "Krajský soud v Brně",
              decisionDate: "1898-06-15",
              caseNumber: "23 C 57/2020",
            },
            {
              court: "Krajský soud v Brně",
              decisionDate: "2025-12-31",
              caseNumber: "6 As 99/2026",
            },
            { court: "Krajský soud v Brně", decisionDate: "2024-03-20" },
            { court: "Okresní soud v Benešově", decisionDate: null },
            { court: "", decisionDate: "0001-01-01" },
            { court: "Krajský soud v Brně", decisionDate: "9999-01-01" },
          ];
          const regionalCourts = Object.values(CZ_ECLI_COURT_REGISTRY).map(
            ({ name }) => name,
          );
          expect(regionalCourts.length).toBeGreaterThan(
            LIMITS.caseLawFacetLimit,
          );
          await tx.insert(caseLawDecisions).values([
            ...datedRows.map((row, index) => ({
              ...row,
              id: createSafeId<"caseLawDecision">(),
              sourceId: multiCourtSourceId,
              country: "CZE",
              language: "cs",
              caseNumber: row.caseNumber ?? `6 As ${index + 1}/2024`,
              fulltext: "Rozsudek ve správním soudnictví.",
            })),
            {
              id: createSafeId<"caseLawDecision">(),
              sourceId: multiCourtSourceId,
              country: "CZE",
              language: "cs",
              court: "Nejvyšší správní soud",
              caseNumber: "6 As 10/2024",
              fulltext: null,
              decisionDate: "2024-01-01",
              redactedAt: new Date(),
              textState: null,
            },
            ...regionalCourts.map((court, index) => ({
              id: createSafeId<"caseLawDecision">(),
              sourceId: undatedSourceId,
              country: "CZE",
              language: "cs",
              court,
              caseNumber: `12 Co ${index + 1}/2024`,
              decisionDate: null,
              fulltext: "Rozhodnutí v občanskoprávní věci.",
            })),
          ]);
          await tx.insert(caseLawBrowseFacetCounts).values({
            kind: "court",
            country: "CZE",
            sourceId,
            value: "Nejvyšší soud",
            total: 1,
          });
          const result = await computeCaseLawCoverageAnswer(
            async (read) => await read(tx),
            [],
          );
          expect(result.complete).toBe(true);
          if ("message" in result.answer) {
            panic("The corpus must produce coverage");
          }
          expect(result.answer.totals.addedLastWeek).toBeNull();
          const computedCountry = result.answer.countries.find(
            ({ country }) => country === "CZE",
          );
          if (
            computedCountry?.availability !==
            CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE
          ) {
            panic("Czech coverage must be searchable");
          }
          expect(computedCountry.sources).toHaveLength(4);
          expect(
            computedCountry.sources.find(
              ({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_US,
            ),
          ).toMatchObject({
            publishedDecisions: 0,
            courts: [],
            decisionYearFrom: null,
            decisionYearTo: null,
          });
          expect(
            computedCountry.sources.find(
              ({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_NS,
            ),
          ).toMatchObject({ publishedDecisions: 1 });
          for (const source of computedCountry.sources) {
            expect(
              source.courts.reduce((total, row) => total + row.decisions, 0),
            ).toBe(source.publishedDecisions);
            expect(source.courts.length).toBeLessThanOrEqual(
              LIMITS.caseLawFacetLimit + 1,
            );
          }
          const multiCourt = computedCountry.sources.find(
            ({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_NSS,
          );
          expect(multiCourt).toMatchObject({
            publishedDecisions: datedRows.length,
            storedDecisions: 50,
            decisionYearFrom: 2024,
            decisionYearTo: 2024,
          });
          expect(multiCourt?.courts).toEqual(
            expect.arrayContaining([
              { court: "Krajský soud v Brně", decisions: 4 },
              { court: "Okresní soud v Benešově", decisions: 1 },
              { court: null, decisions: 1 },
            ]),
          );
          const undated = computedCountry.sources.find(
            ({ adapterKey }) => adapterKey === ADAPTER_KEYS.CZ_REGIONAL,
          );
          expect(undated).toMatchObject({
            publishedDecisions: regionalCourts.length,
            decisionYearFrom: null,
            decisionYearTo: null,
          });
          expect(undated?.courts).toContainEqual({
            court: null,
            decisions: regionalCourts.length - LIMITS.caseLawFacetLimit,
          });
          expect(computedCountry.decisionYearFrom).toBe(2024);
          expect(computedCountry.decisionYearTo).toBe(2026);
          await refreshPgFtsBrowseFacets(tx);
          const snapshot = await computeCaseLawCoverageAnswer(
            async (read) => await read(tx),
            [],
          );
          expect(snapshot.complete).toBe(true);
          if ("message" in snapshot.answer) {
            panic("The facet snapshot must produce coverage");
          }
          const snapshotCountry = snapshot.answer.countries.find(
            ({ country }) => country === "CZE",
          );
          expect(
            snapshotCountry?.sources.map(
              ({ adapterKey, publishedDecisions, courts }) => ({
                adapterKey,
                publishedDecisions,
                courts,
              }),
            ),
          ).toEqual(
            computedCountry.sources.map(
              ({ adapterKey, publishedDecisions, courts }) => ({
                adapterKey,
                publishedDecisions,
                courts,
              }),
            ),
          );
        });
      } finally {
        resetPublicCaseLawConfigForTesting();
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 30_000);
});
