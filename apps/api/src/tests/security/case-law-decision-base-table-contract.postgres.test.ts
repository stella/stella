import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { stellaCaseLawReader, stellaPublicLawReader } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { readCitationGraphFacts } from "@/api/handlers/case-law/analysis/significance";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import { lookupDecisionsByIdentity } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { GateSurface } from "@/api/lib/case-law/public-subject";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The contract migration closes `case_law_decisions` to both reader roles:
 * it revokes their table and column SELECT and drops their policies, so every
 * decision read they make goes through `case_law_published_decisions` or
 * `case_law_unredacted_decisions`. This runs against the migrated database
 * CI builds and holds that state from both sides: the production read paths
 * still return decisions under each role, and a direct read of the base
 * table is refused to each.
 *
 * Every fixture row is written inside a transaction that rolls back, so the
 * suite leaves the shared server as it found it.
 */

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const PUBLIC_READER = stellaPublicLawReader.name;
const LEGACY_READER = stellaCaseLawReader.name;
const READER_ROLES = [PUBLIC_READER, LEGACY_READER] as const;
const BASE_TABLE = "case_law_decisions";
const DECISION_VIEWS = [
  "case_law_published_decisions",
  "case_law_unredacted_decisions",
] as const;

/** Both jurisdictions on the page surface, whatever the launch list says. */
const PAGES: GateSurface = {
  surface: "pages",
  surfaceCountries: {
    identity: ["CZE", "SVK"],
    pages: ["CZE", "SVK"],
    search: ["CZE", "SVK"],
  },
};

const errorAndCauseMessages = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  return cause === undefined
    ? error.message
    : `${error.message} ${errorAndCauseMessages(cause)}`;
};

type Fixture = ReturnType<typeof newFixture>;

const newFixture = () => ({
  sourceId: createSafeId<"caseLawSource">(),
  /** Nejvyšší soud, the decision every read below names. */
  czech: createSafeId<"caseLawDecision">(),
  /** A later Czech decision citing it. */
  citing: createSafeId<"caseLawDecision">(),
  /** Najvyšší súd, a Slovak decision of the same source. */
  slovak: createSafeId<"caseLawDecision">(),
  /** A redacted decision: no published view may return it. */
  redacted: createSafeId<"caseLawDecision">(),
  citationId: createSafeId<"caseLawCitation">(),
  suffix: String(Math.floor(Math.random() * 1_000_000)),
});

const czechCaseNumber = (fixture: Fixture) => `21 Cdo ${fixture.suffix}/2024`;
const czechEcli = (fixture: Fixture) =>
  `ECLI:CZ:NS:2024:21.CDO.${fixture.suffix}.2024.1`;

/** Owner-side writes of the rows the reads return. */
const seed = async (tx: Transaction, fixture: Fixture): Promise<void> => {
  await tx.execute(sql`
    INSERT INTO case_law_sources (id, adapter_key, name)
    VALUES (${fixture.sourceId}, ${`base-contract-${fixture.suffix}`},
      'Sbírka rozhodnutí')
  `);
  await tx.execute(sql`
    INSERT INTO case_law_decisions
      (id, source_id, case_number, ecli, court, country, language,
       decision_date, fulltext)
    VALUES
      (${fixture.czech}, ${fixture.sourceId}, ${czechCaseNumber(fixture)},
       ${czechEcli(fixture)}, 'Nejvyšší soud', 'CZE', 'cs', '2024-03-12',
       'Žalobkyně Jana Nováková se domáhala náhrady škody.'),
      (${fixture.citing}, ${fixture.sourceId},
       ${`23 Cdo ${fixture.suffix}/2025`}, NULL, 'Nejvyšší soud', 'CZE', 'cs',
       '2025-01-20', 'Soud vyšel z rozsudku 21 Cdo.'),
      (${fixture.slovak}, ${fixture.sourceId},
       ${`5Cdo/${fixture.suffix}/2023`}, NULL, 'Najvyšší súd', 'SVK', 'sk',
       '2023-06-08', 'Žalobkyňa Ľubica Hrušková podala dovolanie.'),
      (${fixture.redacted}, ${fixture.sourceId},
       ${`30 Cdo ${fixture.suffix}/2022`}, NULL, 'Nejvyšší soud', 'CZE', 'cs',
       '2022-09-01', NULL)
  `);
  await tx.execute(sql`
    UPDATE case_law_decisions SET redacted_at = now()
    WHERE id = ${fixture.redacted}
  `);
  await tx.execute(sql`
    INSERT INTO case_law_citations
      (id, citing_decision_id, cited_decision_id, citation_text, kind)
    VALUES (${fixture.citationId}, ${fixture.citing}, ${fixture.czech},
      ${czechCaseNumber(fixture)}, 'precedent')
  `);
};

/**
 * Seed as the owner, then run `fn` as `role`, in one transaction that always
 * rolls back.
 */
const asRoleOverFixture = async (
  url: string,
  role: string,
  fn: (tx: Transaction, fixture: Fixture) => Promise<void>,
): Promise<void> =>
  await withGatedTestClients(url, async ({ openClient }) => {
    const database = openClient().db;
    const fixture = newFixture();
    try {
      await database.transaction(async (tx) => {
        // PostgreSQL 16+ gives a role creator ADMIN membership without SET.
        // Roll this fixture membership back with the rest of the transaction.
        await tx.execute(
          sql`GRANT ${sql.identifier(role)} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
        );
        await seed(tx, fixture);
        await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
        await fn(tx, fixture);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }
  });

/** A public read handle that runs every read on the role's transaction. */
const readerDbOn = (tx: Transaction): CaseLawPublicReadDb =>
  asTestRaw<CaseLawPublicReadDb>(
    async <T>(fn: (readTx: CaseLawPublicReadTransaction) => Promise<T>) =>
      await fn(tx),
  );

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law decision base table contract (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("case-law decision base table contract (postgres)", () => {
    test("neither reader holds a grant or a policy on the base table", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const database = openClient().db;
        for (const role of READER_ROLES) {
          const [access] = await database.execute<{
            tableWide: boolean;
            anyColumn: boolean;
            policies: number;
            views: boolean;
          }>(sql`
            SELECT
              has_table_privilege(${role}, 'public.case_law_decisions', 'SELECT')
                AS "tableWide",
              has_any_column_privilege(${role}, 'public.case_law_decisions', 'SELECT')
                AS "anyColumn",
              (SELECT count(*)::integer FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename = ${BASE_TABLE}
                  AND ${role} = ANY (roles)) AS policies,
              has_column_privilege(${role}, 'public.case_law_published_decisions', 'id', 'SELECT')
                AND has_column_privilege(${role}, 'public.case_law_unredacted_decisions', 'id', 'SELECT')
                AS views
          `);
          expect({ role, ...access }).toEqual({
            role,
            tableWide: false,
            anyColumn: false,
            policies: 0,
            views: true,
          });
        }
      });
    });

    test("a direct base-table read is refused to each reader", async () => {
      for (const role of READER_ROLES) {
        for (const statement of [
          sql`SELECT id FROM case_law_decisions LIMIT 1`,
          sql`SELECT count(*) FROM case_law_decisions`,
        ]) {
          const failure = await rejectionOf(
            asRoleOverFixture(databaseUrl, role, async (tx, fixture) => {
              await tx.execute(statement);
              panic(`${role} read the base table for ${fixture.czech}`);
            }),
          );
          expect(failure).toBeInstanceOf(Error);
          expect(errorAndCauseMessages(failure)).toContain("permission denied");
          expect(errorAndCauseMessages(failure)).toContain(BASE_TABLE);
        }
      }
    });

    test("the public-law reader serves decision reads through the views", async () => {
      await asRoleOverFixture(
        databaseUrl,
        PUBLIC_READER,
        async (tx, fixture) => {
          const readerDb = readerDbOn(tx);
          try {
            // The court registry is read on the same transaction, as the role.
            resetPublicCaseLawConfigForTesting(readerDb);

            const czech = await withRedistributableSubject(
              readerDb,
              PAGES,
              { kind: "id", id: fixture.czech },
              async (subject) => await readDecisionHandler({ subject }),
            );
            expect(czech).toMatchObject({
              id: fixture.czech,
              caseNumber: czechCaseNumber(fixture),
              court: "Nejvyšší soud",
              ecli: czechEcli(fixture),
            });

            const slovak = await withRedistributableSubject(
              readerDb,
              PAGES,
              { kind: "id", id: fixture.slovak },
              async (subject) => await readDecisionHandler({ subject }),
            );
            expect(slovak).toMatchObject({
              id: fixture.slovak,
              caseNumber: `5Cdo/${fixture.suffix}/2023`,
              court: "Najvyšší súd",
            });

            // A redacted decision has no subject: the view's filter hides it.
            expect(
              await withRedistributableSubject(
                readerDb,
                PAGES,
                { kind: "id", id: fixture.redacted },
                async ({ id }) => id,
              ),
            ).toBeNull();

            const byEcli = await lookupDecisionsByIdentity({
              caseLawDb: readerDb,
              country: "CZE",
              countries: ["CZE", "SVK"],
              locator: { kind: "ecli", value: czechEcli(fixture) },
            });
            expect(byEcli.map(({ id }) => id)).toEqual([fixture.czech]);

            const facts = await readCitationGraphFacts({
              decisionId: fixture.czech,
              tx,
            });
            expect(facts).toMatchObject({
              decisionId: fixture.czech,
              citedByCount: 1,
              citingDecisionIds: [fixture.citing],
            });
          } finally {
            resetPublicCaseLawConfigForTesting();
          }
        },
      );
    });

    test("the legacy reader reads decisions through the views alone", async () => {
      await asRoleOverFixture(
        databaseUrl,
        LEGACY_READER,
        async (tx, fixture) => {
          const ids = sql.join(
            [
              fixture.czech,
              fixture.citing,
              fixture.slovak,
              fixture.redacted,
            ].map((id) => sql`${id}`),
            sql`, `,
          );
          const published = await tx.execute<{ id: string; court: string }>(sql`
          SELECT id, court FROM case_law_published_decisions
          WHERE id IN (${ids})
          ORDER BY decision_date
        `);
          expect(published.map(({ id, court }) => ({ id, court }))).toEqual([
            { id: fixture.slovak, court: "Najvyšší súd" },
            { id: fixture.czech, court: "Nejvyšší soud" },
            { id: fixture.citing, court: "Nejvyšší soud" },
          ]);
          const unredacted = await tx.execute<{ id: string }>(sql`
          SELECT id FROM case_law_unredacted_decisions
          WHERE id IN (${ids})
        `);
          expect(unredacted.map(({ id }) => id).toSorted()).toEqual(
            [fixture.czech, fixture.citing, fixture.slovak].toSorted(),
          );
          // Its citation and source reads, which keep their own grants.
          const citations = await tx.execute<{ cited: string }>(sql`
          SELECT cited_decision_id AS cited FROM case_law_citations
          WHERE id = ${fixture.citationId}
        `);
          expect(citations.map(({ cited }) => cited)).toEqual([fixture.czech]);
          const sources = await tx.execute<{ name: string }>(sql`
          SELECT name FROM case_law_sources WHERE id = ${fixture.sourceId}
        `);
          expect(sources.map(({ name }) => name)).toEqual([
            "Sbírka rozhodnutí",
          ]);
          for (const view of DECISION_VIEWS) {
            const [privilege] = await tx.execute<{ writable: boolean }>(sql`
            SELECT has_table_privilege(current_user, ${`public.${view}`}, 'INSERT,UPDATE,DELETE')
              AS writable
          `);
            expect(privilege?.writable).toBe(false);
          }
        },
      );
    });
  });
}
