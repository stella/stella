import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import {
  exactDecisionMatches,
  parseDecisionQuery,
} from "@stll/api-contract/decision-query-intent";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import {
  citationKeyOf,
  normalizeDecisionIdentifierValueIn,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * An exact lookup reads a docket in either year form: the stored key keeps
 * its publisher's printing, and the lookup compares match keys, through the
 * decision's own key and through its identifier rows. Neutral fictional
 * dockets; one Court of Justice case and Czech ones.
 */

const DB_TEST_TIMEOUT_MS = 120_000;

const euSourceId = createSafeId<"caseLawSource">();
const czSourceId = createSafeId<"caseLawSource">();
const euTwoDigit = createSafeId<"caseLawDecision">();
const czFourDigit = createSafeId<"caseLawDecision">();
const czParallel = createSafeId<"caseLawDecision">();
const czNeighbour = createSafeId<"caseLawDecision">();

const docketLocator = (value: string) =>
  ({
    kind: "docket",
    value,
    family: value,
    selector: { kind: "none" },
  }) as const;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
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

    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        id: euSourceId,
        name: "court of justice",
      }),
      caseLawSourceRow({ adapterKey: "open", id: czSourceId, name: "open" }),
    ]);
    const decision = (
      id: typeof euTwoDigit,
      fields: {
        sourceId: typeof euSourceId;
        caseNumber: string;
        country: string;
        court: string;
        decisionDate: string;
        language: string;
      },
    ) =>
      ({
        ...fields,
        id,
        citationKey: citationKeyOf(fields.caseNumber),
        languageGroupKey: id,
        slug: id,
      }) satisfies typeof caseLawDecisions.$inferInsert;
    await db.insert(caseLawDecisions).values([
      decision(euTwoDigit, {
        sourceId: euSourceId,
        caseNumber: "C-679/18",
        country: "EU",
        court: "Court of Justice",
        decisionDate: "2019-10-01",
        language: "en",
      }),
      decision(czFourDigit, {
        sourceId: czSourceId,
        caseNumber: "44 Cdo 77/2016",
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: "2016-09-01",
        language: "cs",
      }),
      decision(czParallel, {
        sourceId: czSourceId,
        caseNumber: "45 Cdo 10/2014",
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: "2014-05-01",
        language: "cs",
      }),
      // Another case of the same number in another year: never read.
      decision(czNeighbour, {
        sourceId: czSourceId,
        caseNumber: "44 Cdo 77/2017",
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: "2017-09-01",
        language: "cs",
      }),
    ]);
    // A joined case's docket, held only as a parallel identifier.
    await db.insert(caseLawDecisionIdentifiers).values({
      decisionId: czParallel,
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: "46 Cdo 20/2014",
      normalizedValue: normalizeDecisionIdentifierValueIn(
        "CZE",
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        "46 Cdo 20/2014",
      ),
    });
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const idsRead = async (country: string, docket: string) =>
  (
    await lookupDecisionsByIdentity({
      caseLawDb,
      country,
      locator: docketLocator(docket),
    })
  ).map(({ id }) => id);

test("a four-digit docket finds the decision stored with two", async () => {
  expect(await idsRead("EU", "C-679/2018")).toEqual([euTwoDigit]);
  expect(await idsRead("EU", "C-679/18")).toEqual([euTwoDigit]);
});

test("a two-digit docket finds the decision stored with four, and not the next year's", async () => {
  expect(await idsRead("CZE", "44 Cdo 77/16")).toEqual([czFourDigit]);
  expect(await idsRead("CZE", "44 Cdo 77/2016")).toEqual([czFourDigit]);
  expect(await idsRead("CZE", "44 Cdo 77/17")).toEqual([czNeighbour]);
});

test("a parallel docket identifier is read in either year form", async () => {
  expect(await idsRead("CZE", "46 Cdo 20/14")).toEqual([czParallel]);
});

test("a different case beyond the year finds nothing", async () => {
  expect(await idsRead("EU", "C-697/2018")).toEqual([]);
  expect(await idsRead("CZE", "44 Cdo 78/16")).toEqual([]);
});

test("the exact filter keeps the decision the lookup read in the other year form", async () => {
  const intent = parseDecisionQuery("44 Cdo 77/16", {
    grammar: DECISION_DOCKET_GRAMMARS.CZE,
  });
  if (intent.type !== "identifier") {
    panic("The two-digit docket is not read as an identifier");
  }
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: decisionIdentityLocatorOf(intent),
  });
  expect(exactDecisionMatches(intent, rows).map(({ id }) => id)).toEqual([
    czFourDigit,
  ]);
});
