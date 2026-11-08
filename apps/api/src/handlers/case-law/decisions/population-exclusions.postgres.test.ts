import { panic, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getViewConfig, PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
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
  readCaseLawCoverageSourcesQuery,
} from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { readPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facets";
import { LIMITS } from "@/api/lib/limits";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const INCLUDED_COURTS = LIMITS.caseLawFacetLimit + 1;
class PopulationExclusionRollback extends TaggedError(
  "PopulationExclusionRollback",
)<{
  message: string;
}> {}

type ExclusionFixture = {
  tx: CaseLawPublicReadTransaction;
  includedSourceId: SafeId<"caseLawSource">;
  excludedSourceId: SafeId<"caseLawSource">;
};

const withExclusionFixture = async (
  work: (fixture: ExclusionFixture) => Promise<void>,
) => {
  const databaseUrl =
    process.env["DATABASE_URL"] ??
    panic("Population exclusion proof requires DATABASE_URL");
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient({ max: 1 });
    const rollback = new PopulationExclusionRollback({
      message: "Roll back exclusion fixture",
    });
    resetPublicCaseLawConfigForTesting();
    try {
      expect(
        await rejectionOf(
          db.transaction(async (tx) => {
            const schemaName = `population_exclusion_${Bun.randomUUIDv7().replaceAll("-", "")}`;
            const schema = sql.identifier(schemaName);
            await tx.execute(sql`CREATE SCHEMA ${schema}`);
            for (const table of [
              "case_law_sources",
              "case_law_source_arrivals",
              "case_law_decisions",
              "case_law_search_documents",
              "case_law_court_weights",
            ]) {
              await tx.execute(
                sql`CREATE TABLE ${schema}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
              );
            }
            const migration = await Bun.file(
              new URL(
                "../../../../drizzle/20261101022151_case_law_population_counts/migration.sql",
                import.meta.url,
              ),
            ).text();
            const isolated = migration.replaceAll(
              /\bpublic\.([a-z_]*case_law_population[a-z_]*|case_law_decisions|case_law_sources)\b/gu,
              (match) => match.replace("public.", () => `"${schemaName}".`),
            );
            for (const statement of isolated.split(
              "--> statement-breakpoint",
            )) {
              if (statement.trim() !== "") {
                // db-await-in-loop: install the production population owner against this isolated fixture only.
                await tx.execute(sql.raw(statement));
              }
            }
            await tx.execute(sql`SET LOCAL search_path TO ${schema}, public`);
            const dialect = new PgDialect();
            for (const view of [
              publishedCaseLawDecisions,
              unredactedCaseLawDecisions,
            ]) {
              const config = getViewConfig(view);
              await tx.execute(
                sql`CREATE VIEW ${schema}.${sql.identifier(config.name)} AS (${sql.raw(dialect.sqlToQuery(config.query).sql)})`,
              );
            }
            const includedSourceId = createSafeId<"caseLawSource">();
            const excludedSourceId = createSafeId<"caseLawSource">();
            const now = new Date();
            await tx.insert(caseLawSources).values([
              caseLawSourceRow({
                id: includedSourceId,
                adapterKey: ADAPTER_KEYS.CZ_NS,
                storedTotal: INCLUDED_COURTS,
                storedTotalAsOf: now,
              }),
              caseLawSourceRow({
                id: excludedSourceId,
                adapterKey: ADAPTER_KEYS.CZ_NSS,
                storedTotal: 1,
                storedTotalAsOf: now,
              }),
            ]);
            await tx.insert(caseLawSourceArrivals).values([
              {
                sourceId: includedSourceId,
                addedLastWeek: INCLUDED_COURTS,
                countedAt: now,
              },
              { sourceId: excludedSourceId, addedLastWeek: 1, countedAt: now },
            ]);
            await tx.insert(caseLawCourtWeights).values({
              country: "CZE",
              courtPattern: "^Allowed court",
              tier: 3,
              tierLabel: "supreme",
              weight: 1,
            });
            await tx.insert(caseLawDecisions).values([
              ...Array.from({ length: INCLUDED_COURTS }, (_, index) => ({
                id: createSafeId<"caseLawDecision">(),
                sourceId: includedSourceId,
                caseNumber: `Included decision ${index}`,
                court: `Allowed court ${String(index).padStart(4, "0")}`,
                country: "CZE",
                language: "cs",
                decisionDate: "2020-01-01",
                fulltext: "Included fixture text",
              })),
              {
                id: createSafeId<"caseLawDecision">(),
                sourceId: excludedSourceId,
                caseNumber: "Excluded decision",
                court: "Excluded court",
                country: "CZE",
                language: "cs",
                decisionDate: "2021-01-01",
                fulltext: "Excluded fixture text",
              },
            ]);
            let seeded = false;
            while (!seeded) {
              // db-await-in-loop: finish the two-source production seed in bounded batches.
              const [row] = await tx.execute(
                sql`SELECT done FROM ${schema}.seed_case_law_population_counts(2048)`,
              );
              seeded = row?.["done"] === true;
            }
            await work({
              tx: asTestRaw<CaseLawPublicReadTransaction>(tx),
              includedSourceId,
              excludedSourceId,
            });
            abortTransaction(rollback);
          }),
        ),
      ).toBe(rollback);
    } finally {
      resetPublicCaseLawConfigForTesting();
    }
  });
};

describe.skipIf(!enabled)(
  "maintained population source exclusions (postgres)",
  () => {
    test("explicit exclusions remove source country court and year counts while its descriptor permits redistribution", async () => {
      await withExclusionFixture(
        async ({ tx, includedSourceId, excludedSourceId }) => {
          const all = await readPgFtsBrowseFacets(tx, {
            excludedSourceIds: [],
            limit: INCLUDED_COURTS + 1,
          });
          expect(all.country).toEqual([
            { value: "CZE", count: INCLUDED_COURTS + 1 },
          ]);
          expect(
            all.court.some(({ value }) => value === "Excluded court"),
          ).toBe(true);
          expect(all.year.some(({ value }) => value === "2021")).toBe(true);
          const excluded = await readPgFtsBrowseFacets(tx, {
            excludedSourceIds: [excludedSourceId],
            limit: INCLUDED_COURTS + 1,
          });
          expect(excluded.country).toEqual([
            { value: "CZE", count: INCLUDED_COURTS },
          ]);
          expect(excluded.court).toHaveLength(INCLUDED_COURTS);
          expect(
            excluded.court.every(
              ({ value, count }) =>
                value.startsWith("Allowed court") && count === 1,
            ),
          ).toBe(true);
          expect(excluded.year).toEqual([
            { value: "2020", count: INCLUDED_COURTS },
          ]);
          const sources = await readCaseLawCoverageSourcesQuery(tx, [
            excludedSourceId,
          ]);
          expect(sources.map(({ id }) => id)).toEqual([includedSourceId]);
          expect(sources.at(0)).toMatchObject({
            publishedDecisions: INCLUDED_COURTS,
            decisionYearFrom: 2020,
            decisionYearTo: 2020,
          });
        },
      );
    }, 30_000); // timeout: install the real migration and exercise every facet population on migrated PostgreSQL.

    test("coverage distinct court totals honor exclusions beyond the facet page", async () => {
      await withExclusionFixture(
        async ({ tx, includedSourceId, excludedSourceId }) => {
          const { answer, complete } = await computeCaseLawCoverageAnswer(
            async (read) => await read(tx),
            [excludedSourceId],
          );
          expect(complete).toBe(true);
          if ("message" in answer) {
            panic("Exclusion fixture must produce a coverage answer");
          }
          const country = answer.countries.find(
            ({ country: countryCode }) => countryCode === "CZE",
          );
          if (
            country?.availability !== CASE_LAW_COVERAGE_AVAILABILITY.SEARCHABLE
          ) {
            panic("Exclusion fixture country must be searchable");
          }
          expect(country.searchable).toBe(INCLUDED_COURTS);
          expect(country.sources).toHaveLength(1);
          expect(country.sources.at(0)).toMatchObject({
            adapterKey: ADAPTER_KEYS.CZ_NS,
            publishedDecisions: INCLUDED_COURTS,
          });
          expect(
            country.courts?.find(({ type }) => type === "other-courts"),
          ).toMatchObject({ type: "other-courts", courts: 1, decisions: 1 });
          expect(
            (await readCaseLawCoverageSourcesQuery(tx, [excludedSourceId])).map(
              ({ id }) => id,
            ),
          ).toEqual([includedSourceId]);
        },
      );
    }, 30_000); // timeout: the complete coverage path reads the bounded source populations and distinct-court remainder.
  },
);
