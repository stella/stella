import { panic } from "better-result";
import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import { databaseRelations } from "@/api/db/database-relations";
import { stellaPublicLawReader } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import {
  CASE_LAW_SEARCH_FACETS,
  caseLawSearchPlan,
  readCaseLawSearchFacet,
  readCaseLawSearchHits,
  readCaseLawSearchTotal,
} from "@/api/handlers/case-law/decisions/search";
import { readLegislationSearchHits } from "@/api/handlers/legislation/search";
import {
  readCourtWeightRowsQuery,
  readFtsConfigRowsQuery,
} from "@/api/lib/case-law/case-law-config-read";
import { createCourtWeightCache } from "@/api/lib/case-law/court-weights";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";
import { createFtsConfigCache } from "@/api/lib/legal-search/fts-config";
import {
  PROVIDER_SEARCH_FACETS,
  providerSearchPlan,
  readProviderSearchFacet,
  readProviderSearchHits,
} from "@/api/lib/legal-search/pg-fts-legal-provider";
import {
  publicLawDatabaseRolePermissionsSql,
  type PublicLawDatabaseRolePermissions,
} from "@/api/lib/public-law-read-db";
import {
  PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";

/**
 * The reader-role suite builds its role from the relation map, so it cannot
 * tell whether the committed migrations grant what the map says. This one
 * runs against the migrated database CI builds, where the role holds exactly
 * what the migrations granted: the grant bounds, the attestation and the
 * production search and configuration reads, all as the role itself.
 */

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const READER_ROLE = stellaPublicLawReader.name;
const PUBLIC_COUNTRY =
  publicCaseLawCountry("CZE") ?? panic("Expected a public test country.");

const SEARCH_QUERY = "reader role census";

/** Run `fn` as the reader role in a transaction that always rolls back. */
const asReader = async (
  url: string,
  fn: (tx: Transaction) => Promise<void>,
): Promise<void> => {
  const client = new SQL({ url, max: 1 });
  const database = drizzle({ client, relations: databaseRelations });
  try {
    await database.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE "${READER_ROLE}"`));
      await fn(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  } finally {
    await client.close();
  }
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("public-law reader role on the migrated schema (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("public-law reader role on the migrated schema (postgres)", () => {
    test("holds the required columns and nothing the map does not declare", async () => {
      const client = new SQL({ url: databaseUrl, max: 1 });
      const database = drizzle({ client, relations: databaseRelations });
      try {
        const rows = await database.execute<{
          qualified: string;
          tableWide: boolean;
        }>(sql`
          SELECT
            tables.relname || '.' || columns.attname AS qualified,
            has_table_privilege(${READER_ROLE}, tables.oid, 'SELECT')
              AS "tableWide"
          FROM pg_attribute AS columns
          INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND columns.attnum > 0
            AND NOT columns.attisdropped
            AND has_column_privilege(
              ${READER_ROLE},
              columns.attrelid,
              columns.attnum,
              'SELECT'
            )
        `);
        const granted = new Set(rows.map(({ qualified }) => qualified));
        const pairs = publicLawColumnPairs(
          PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION,
        );
        const declared = new Set(
          pairs.map(({ relation, column }) => `${relation}.${column}`),
        );

        expect(rows.filter(({ tableWide }) => tableWide)).toEqual([]);
        expect(
          pairs
            .filter(({ grant }) => grant === "required")
            .map(({ relation, column }) => `${relation}.${column}`)
            .filter((column) => !granted.has(column)),
        ).toEqual([]);
        expect([...granted].filter((column) => !declared.has(column))).toEqual(
          [],
        );
      } finally {
        await client.close();
      }
    });

    test("passes the attestation's grant bounds", async () => {
      let permissions: PublicLawDatabaseRolePermissions | undefined;
      await asReader(databaseUrl, async (tx) => {
        const [row] = await tx.execute<PublicLawDatabaseRolePermissions>(
          publicLawDatabaseRolePermissionsSql(),
        );
        permissions = row;
      });

      expect(permissions).toMatchObject({
        canReadPublicLaw: true,
        canReadOtherData: false,
      });
    });

    test("runs the search and configuration reads", async () => {
      // Counted as each statement returns, so a read that failed, or a run
      // that stopped early, cannot pass for one that reached the end.
      let statements = 0;
      const counted = async <T>(read: Promise<T>): Promise<T> => {
        const result = await read;
        statements += 1;
        return result;
      };
      await asReader(databaseUrl, async (tx) => {
        const ftsRows = await counted(readFtsConfigRowsQuery(tx));
        const courtWeightRows = await counted(readCourtWeightRowsQuery(tx));
        const configs = await createFtsConfigCache(
          async () => ftsRows,
        ).loadFtsSearchConfigs();
        const courtWeights = await createCourtWeightCache(
          async () => courtWeightRows,
        ).load();

        const plan = caseLawSearchPlan({
          body: {
            country: PUBLIC_COUNTRY,
            language: "cs",
            query: SEARCH_QUERY,
          },
          configs,
          courtWeights,
          excerpt: DEFAULT_SEARCH_EXCERPT,
          limit: 10,
          parsedCursor: null,
          queryUsed: SEARCH_QUERY,
          sort: DEFAULT_SEARCH_SORT,
        });
        await counted(readCaseLawSearchHits(tx, plan));
        await counted(readCaseLawSearchTotal(tx, plan));
        for (const facet of CASE_LAW_SEARCH_FACETS) {
          await counted(readCaseLawSearchFacet(tx, plan, facet));
        }

        const providerPlan = providerSearchPlan({
          configs,
          courtWeights,
          parsedCursor: null,
          query: {
            jurisdiction: PUBLIC_COUNTRY,
            limit: 10,
            query: SEARCH_QUERY,
          },
        });
        await counted(readProviderSearchHits(tx, providerPlan));
        for (const facet of PROVIDER_SEARCH_FACETS) {
          await counted(readProviderSearchFacet(tx, providerPlan, facet));
        }

        await counted(
          readLegislationSearchHits(tx, {
            body: { query: SEARCH_QUERY },
            configs,
            limit: 10,
            parsedCursor: null,
          }),
        );
      });

      expect(statements).toBe(
        2 +
          2 +
          CASE_LAW_SEARCH_FACETS.length +
          1 +
          PROVIDER_SEARCH_FACETS.length +
          1,
      );
    });
  });
}
