import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";

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
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The docket-family identity scenario on an embedded Postgres, under the
 * public reader role the search and the lookup tool read with. The same
 * scenario runs on a real server in the Postgres job
 * (`docket-family-identity.postgres.test.ts`).
 */

const sourceId = createSafeId<"caseLawSource">();
const scenario = docketFamilyScenario(100);
const grammarScenario = docketGrammarFamilyScenario(100);

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;
let setFamilyKeyGrant: (mode: "grant" | "revoke") => Promise<void>;

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    setFamilyKeyGrant = async (mode) => {
      await db.execute(docketFamilyKeyGrantSql(mode));
    };
    await setFamilyKeyGrant("grant");
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db
      .insert(caseLawSources)
      .values([
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      ]);
    await db
      .insert(caseLawDecisions)
      .values(docketFamilyDecisionRows(scenario, sourceId));
    await db
      .insert(caseLawDecisions)
      .values(docketGrammarFamilyDecisionRows(grammarScenario, sourceId));
    await db
      .insert(caseLawDecisionIdentifiers)
      .values(docketFamilyIdentifierRows(scenario));
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
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

test("an entry naming two files is not read as either", () => {
  expect(
    parseDecisionQuery(
      `${scenario.dockets.sameDay} a ${scenario.dockets.dated}`,
      { grammar: DECISION_DOCKET_GRAMMARS.CZE },
    ).type,
  ).toBe("text");
});
