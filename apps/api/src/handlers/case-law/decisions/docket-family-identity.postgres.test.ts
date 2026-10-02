/**
 * The docket-family identity scenario on a real Postgres server, read through
 * the public reader connection the search and the lookup tool use. The keys
 * are compared by the server's own collation and planner here, which an
 * embedded engine stands in for elsewhere
 * (`docket-family-identity.db.test.ts`).
 *
 * Runs in the Postgres job; skipped elsewhere.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  describeDocketFamilyIdentity,
  docketFamilyDecisionRows,
  docketFamilyIdentifierRows,
  docketFamilyScenario,
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

    beforeAll(async () => {
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
        .insert(caseLawDecisionIdentifiers)
        .values(docketFamilyIdentifierRows(scenario));
    });

    // The decisions and their identifiers go with their source.
    cleanUp(async () => {
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });

    describeDocketFamilyIdentity(() => ({
      caseLawDb: caseLawPublicReadDb,
      scenario,
    }));
  });
}
