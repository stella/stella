import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getViewConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  caseLawCourtWeights,
  caseLawDecisions,
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
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("coverage computation (postgres)", () => {
  // timeout: exercise the complete coverage read against migrated PostgreSQL.
  test("an admitted country's cold coverage completes within a held single-connection pool", async () => {
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
          "case_law_decisions",
          "case_law_search_documents",
          "case_law_browse_facet_counts",
          "case_law_court_weights",
        ]) {
          // db-await-in-loop: clone the finite migrated corpus fixture.
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
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
            return panic("The fixture must produce a coverage answer");
          }
          expect(answer.totals.searchable).toBe(1);
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
            return panic("The fixture country must be searchable");
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
        });
      } finally {
        resetPublicCaseLawConfigForTesting();
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 30_000);
});
