import { panic } from "better-result";
import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import { stellaPublicLawReader } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { readCitationGraphFacts } from "@/api/handlers/case-law/analysis/significance";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import {
  publicLawDatabaseRolePermissionsSql,
  type PublicLawDatabaseRolePermissions,
} from "@/api/lib/public-law-read-db";
import {
  PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  cleanUpSearchCensus,
  expectedSearchCensus,
  newSearchCensusIds,
  runSearchCensus,
  SEARCH_CENSUS_RELATIONS,
  seedSearchCensus,
} from "@/api/tests/security/public-law-search-census";
import type {
  SearchCensusIds,
  SearchCensusObservation,
} from "@/api/tests/security/public-law-search-census";

/**
 * The reader-role suite builds its role from the relation map, so it cannot
 * tell whether the committed migrations grant what the map says. This one
 * runs against the migrated database CI builds, where the role holds exactly
 * what the migrations granted and the policies they created: the grant
 * bounds, the attestation, and the production search and configuration reads
 * as the role itself, asserted on the rows they return.
 */

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const READER_ROLE = stellaPublicLawReader.name;

const openDatabase = (client: SQL) =>
  drizzle({ client, relations: databaseRelations });

/** A one-connection client, closed once `fn` settles. */
const withClient = async <T>(
  url: string,
  fn: (database: ReturnType<typeof openDatabase>) => Promise<T>,
): Promise<T> => {
  const client = new SQL({ url, max: 1 });
  try {
    return await fn(openDatabase(client));
  } finally {
    await client.close();
  }
};

/**
 * Run `fn` as the reader role in a transaction that always rolls back.
 * `setup` runs first, as the owner.
 */
const asReader = async (
  url: string,
  fn: (tx: Transaction) => Promise<void>,
  setup: (tx: Transaction) => Promise<void> = async () => {},
): Promise<void> =>
  await withClient(url, async (database) => {
    try {
      await database.transaction(async (tx) => {
        await setup(tx);
        await tx.execute(sql.raw(`SET LOCAL ROLE "${READER_ROLE}"`));
        await fn(tx);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }
  });

/** Seed the search census, run `fn`, and remove the census again. */
const withSearchCensus = async (
  url: string,
  fn: (ids: SearchCensusIds) => Promise<void>,
): Promise<void> => {
  const ids = newSearchCensusIds();
  await withClient(url, async (database) => {
    await seedSearchCensus(database, ids);
  });
  try {
    await fn(ids);
  } finally {
    await withClient(url, async (database) => {
      await cleanUpSearchCensus(database, ids);
    });
  }
};

const observeSearchCensus = async (
  url: string,
  setup?: (tx: Transaction) => Promise<void>,
): Promise<SearchCensusObservation> => {
  let observed: SearchCensusObservation | undefined;
  await asReader(
    url,
    async (tx) => {
      observed = await runSearchCensus(tx);
    },
    setup,
  );
  return observed ?? panic("the search census did not run");
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
      const rows = await withClient(
        databaseUrl,
        async (database) =>
          await database.execute<{ qualified: string; tableWide: boolean }>(sql`
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
          `),
      );
      const granted = new Set(rows.map(({ qualified }) => qualified));
      const pairs = publicLawColumnPairs(PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION);
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

    test("the search and configuration reads return the seeded rows", async () => {
      await withSearchCensus(databaseUrl, async (ids) => {
        expect(await observeSearchCensus(databaseUrl)).toEqual(
          expectedSearchCensus(ids),
        );
      });
    });

    // The rows above are visible because the migration's policies admit them:
    // without the policies the same statements succeed and return nothing.
    test("the same reads return nothing once the reader policies are gone", async () => {
      await withSearchCensus(databaseUrl, async () => {
        const observed = await observeSearchCensus(databaseUrl, async (tx) => {
          for (const relation of SEARCH_CENSUS_RELATIONS) {
            await tx.execute(
              sql.raw(
                `DROP POLICY "public_law_reader_access" ON "${relation}"`,
              ),
            );
          }
        });

        expect(observed).toMatchObject({
          ftsConfig: undefined,
          courtWeight: undefined,
          caseLawHitIds: [],
          caseLawTotal: 0,
          providerHitIds: [],
          legislationHitIds: [],
        });
      });
    });

    // A decision read and the significance graph read hold a reader
    // transaction when they ask for the court registry. Over a reader pool of
    // one connection, a cold registry has to be read on that transaction.
    test("a cold court registry is read inside a one-connection reader", async () => {
      await withSearchCensus(databaseUrl, async (ids) => {
        const client = new SQL({ url: databaseUrl, max: 1 });
        const database = openDatabase(client);
        const readerDb = asTestRaw<CaseLawPublicReadDb>(
          async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
            await database.transaction(async (tx) => {
              await tx.execute(sql.raw(`SET LOCAL ROLE "${READER_ROLE}"`));
              return await fn(tx);
            }),
        );
        const { decisionId } = ids;
        try {
          resetPublicCaseLawConfigForTesting(readerDb);
          const decision = await withRedistributableSubject(
            readerDb,
            { kind: "id", id: decisionId },
            async (subject) => await readDecisionHandler({ subject }),
          );
          expect(decision).toMatchObject({ courtTier: "supreme" });

          resetPublicCaseLawConfigForTesting(readerDb);
          const facts = await readerDb(
            async (tx) => await readCitationGraphFacts({ decisionId, tx }),
          );
          expect(facts?.countsByCourtTier).toEqual([{ tier: 3, count: 1 }]);
        } finally {
          resetPublicCaseLawConfigForTesting();
          await client.close();
        }
      });
    });
  });
}
