import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
  DECISION_DOCKET_GRAMMARS,
  type DecisionDocketJurisdiction,
} from "@stll/api-contract/decision-docket-grammar";
import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentities,
  lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { citationKeyOf } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/** A docket both the Czech and the Slovak grammar read. */
const SHARED_DOCKET = "30 Cdo 3130/2021";

const sourceId = createSafeId<"caseLawSource">();
const czechId = createSafeId<"caseLawDecision">();
const slovakId = createSafeId<"caseLawDecision">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;
const queryLog: string[] = [];

const locatorIn = (jurisdiction: DecisionDocketJurisdiction) => {
  const intent = parseDecisionQuery(SHARED_DOCKET, {
    grammar: DECISION_DOCKET_GRAMMARS[jurisdiction],
  });
  return intent.type === "identifier" && intent.kind === "docket"
    ? decisionIdentityLocatorOf(intent)
    : panic(`${SHARED_DOCKET} is not a ${jurisdiction} docket`);
};

// timeout: embedded Postgres fixture writes share the bounded database-test budget.
beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({
    client,
    logger: {
      logQuery: (query) => {
        queryLog.push(query);
      },
    },
  });
  caseLawDb = asTestRaw<CaseLawPublicReadDb>(
    async <T>(fn: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
      await withPublicLawReaderRole(
        db,
        async (roleTx) => await fn(asTestRaw(roleTx)),
      ),
  );

  await db
    .insert(caseLawSources)
    .values(
      caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
    );
  await db.insert(caseLawDecisions).values([
    {
      id: czechId,
      sourceId,
      caseNumber: SHARED_DOCKET,
      citationKey: citationKeyOf(SHARED_DOCKET),
      court: "Nejvyšší soud",
      country: "CZE",
      decisionDate: "2021-11-03",
      language: "cs",
      languageGroupKey: "identities-czech",
    },
    {
      id: slovakId,
      sourceId,
      caseNumber: SHARED_DOCKET,
      citationKey: citationKeyOf(SHARED_DOCKET),
      court: "Najvyšší súd Slovenskej republiky",
      country: "SVK",
      decisionDate: "2021-06-10",
      language: "sk",
      languageGroupKey: "identities-slovak",
    },
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

// timeout: embedded Postgres role-gated reads share the bounded database-test budget.
test(
  "a docket read in two jurisdictions resolves in each, in the statements one jurisdiction takes",
  async () => {
    queryLog.length = 0;
    await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: locatorIn("CZE"),
    });
    const singleStatements = queryLog.length;

    queryLog.length = 0;
    const rows = await lookupDecisionsByIdentities({
      caseLawDb,
      reads: [
        { country: "CZE", locator: locatorIn("CZE") },
        { country: "SVK", locator: locatorIn("SVK") },
      ],
    });

    expect(rows.map(({ id }) => String(id)).toSorted()).toEqual(
      [String(czechId), String(slovakId)].toSorted(),
    );
    // Each jurisdiction's locator matches only within that jurisdiction.
    expect(
      Object.fromEntries(rows.map(({ id, country }) => [String(id), country])),
    ).toEqual({ [String(czechId)]: "CZE", [String(slovakId)]: "SVK" });
    // The second jurisdiction adds no statement: one scan reads both.
    expect(queryLog.length).toBe(singleStatements);
  },
  DB_TEST_TIMEOUT_MS,
);
