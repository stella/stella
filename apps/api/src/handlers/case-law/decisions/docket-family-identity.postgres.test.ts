/**
 * The docket-family identity scenario on a real Postgres server, read as the
 * public reader role the search and the lookup tool use: the job connects as
 * the owner, so each read sets the reader role, as production's reader
 * connection is, and its column grants decide what the read may use. The keys
 * are compared by the server's own collation and planner here, which an
 * embedded engine stands in for elsewhere
 * (`docket-family-identity.db.test.ts`).
 *
 * Runs in the Postgres job; skipped elsewhere.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { DOCKET_IDENTITY_FIXTURE_NUMBER_MAX } from "@stll/api-contract/decision-docket-identity.fixtures";

import { stellaPublicLawReader } from "@/api/db/rls";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  describeDocketFamilyIdentity,
  describeDocketGrammarFamilyIdentity,
  docketFamilyDecisionRows,
  docketFamilyIdentifierRows,
  docketFamilyKeyGrantSql,
  docketFamilyScenario,
  docketGrammarFamilyDecisionRows,
  docketGrammarFamilyScenario,
} from "@/api/tests/helpers/docket-family-identity-scenario";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("docket family identity (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("docket family identity (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const sourceId = createSafeId<"caseLawSource">();
    // A docket number no other suite on the shared server writes.
    const scenario = docketFamilyScenario(
      70_000 + Math.floor(Math.random() * 20_000),
    );
    // The fixtures' own numbering, with years no other suite writes.
    const grammarScenario = docketGrammarFamilyScenario(
      1 + (scenario.number % DOCKET_IDENTITY_FIXTURE_NUMBER_MAX),
    );

    const setFamilyKeyGrant = async (mode: "grant" | "revoke") => {
      await db.execute(docketFamilyKeyGrantSql(mode));
    };

    const readAsPublicReader = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`SET LOCAL ROLE "${stellaPublicLawReader.name}"`),
        );
        return await fn(tx);
      });
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    const caseLawDb = readAsPublicReader as unknown as CaseLawPublicReadDb;

    beforeAll(async () => {
      await setFamilyKeyGrant("grant");
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          adapterKey: `docket-family-${String(scenario.number)}`,
          id: sourceId,
          name: `docket family ${String(scenario.number)}`,
          enabled: false,
        }),
      );
      await db
        .insert(caseLawDecisions)
        .values(docketFamilyDecisionRows(scenario, sourceId));
      await db
        .insert(caseLawDecisions)
        .values(docketGrammarFamilyDecisionRows(grammarScenario, sourceId));
      await db
        .insert(caseLawDecisionIdentifiers)
        .values(docketFamilyIdentifierRows(scenario));
    });

    // The decisions and their identifiers go with their source.
    cleanUp(async () => {
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      await setFamilyKeyGrant("revoke");
    });

    describeDocketFamilyIdentity(() => ({
      caseLawDb,
      scenario,
      setFamilyKeyGrant,
    }));

    describeDocketGrammarFamilyIdentity(() => ({
      caseLawDb,
      scenario: grammarScenario,
    }));
  });
}
