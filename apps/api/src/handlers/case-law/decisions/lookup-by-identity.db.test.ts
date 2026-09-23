import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { lookupDecisionsByIdentity } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import {
  citationKeyOf,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const supremeId = createSafeId<"caseLawDecision">();
const administrativeId = createSafeId<"caseLawDecision">();
const listingOnlyId = createSafeId<"caseLawDecision">();
const restrictedId = createSafeId<"caseLawDecision">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

const identifierRow = ({
  decisionId,
  type,
  value,
}: {
  decisionId: (typeof caseLawDecisionIdentifiers.$inferInsert)["decisionId"];
  type: DecisionIdentifierType;
  value: string;
}) => ({
  decisionId,
  type,
  value,
  normalizedValue: normalizeDecisionIdentifierValue(type, value),
});

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
      caseLawSourceRow({ adapterKey: "open", id: openSourceId, name: "open" }),
      caseLawSourceRow({
        adapterKey: "closed",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: "Publisher",
          license: "restricted",
        },
        id: closedSourceId,
        name: "closed",
      }),
    ]);
    await db.insert(caseLawDecisions).values([
      {
        id: supremeId,
        sourceId: openSourceId,
        caseNumber: "23 Cdo 1572/2012",
        citationKey: citationKeyOf("23 Cdo 1572/2012"),
        court: "Nejvyšší soud",
        country: "CZE",
        decisionDate: "2012-05-01",
        ecli: "ECLI:CZ:NS:2012:23.CDO.1572.2012.1",
        language: "cs",
        languageGroupKey: "lookup-supreme",
        slug: "23-cdo-1572-2012",
      },
      {
        id: administrativeId,
        sourceId: openSourceId,
        caseNumber: "8 As 1/2019",
        citationKey: citationKeyOf("8 As 1/2019"),
        court: "Nejvyšší správní soud",
        country: "CZE",
        decisionDate: "2019-03-02",
        // The publisher gave the ECLI in the parallel identifiers only.
        ecli: null,
        language: "cs",
        languageGroupKey: "lookup-administrative",
        slug: "8-as-1-2019",
      },
      {
        id: listingOnlyId,
        sourceId: openSourceId,
        caseNumber: "1 Afs 1/2020",
        citationKey: citationKeyOf("1 Afs 1/2020"),
        court: "Nejvyšší správní soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "lookup-listing-only",
        metadata: {
          [PARTIAL_OBSERVATION_KEY]: {
            [PARTIAL_OBSERVATION_FIELD.CASE_NUMBER_IS_PLACEHOLDER]: false,
            [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
          },
        },
      },
      {
        id: restrictedId,
        sourceId: closedSourceId,
        caseNumber: "3 Tdo 3/2021",
        citationKey: citationKeyOf("3 Tdo 3/2021"),
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "lookup-restricted",
      },
    ]);
    await db.insert(caseLawDecisionIdentifiers).values([
      // Two parallel references on one decision: a joined case's docket and
      // the reporter citation the publisher prints beside it.
      identifierRow({
        decisionId: supremeId,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "30 Cdo 400/2012",
      }),
      identifierRow({
        decisionId: supremeId,
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "Rc 55/2013",
      }),
      identifierRow({
        decisionId: administrativeId,
        type: DECISION_IDENTIFIER_TYPES.ECLI,
        value: "ECLI:CZ:NSS:2019:8.AS.1.2019",
      }),
      identifierRow({
        decisionId: listingOnlyId,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "2 Afs 2/2020",
      }),
      identifierRow({
        decisionId: restrictedId,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "4 Tdo 4/2021",
      }),
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test("a docket stored only as a parallel identifier resolves to its decision", async () => {
  // The reference a brief carries need not be the docket the corpus keyed the
  // row by: a joined case is cited under either number, and only one of them
  // is in `citation_key`.
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "docket", value: "30 Cdo 400/2012" },
  });

  expect(rows.map(({ id }) => id)).toEqual([supremeId]);
  // The parallel references travel with the row, so the caller's exact-identity
  // filter sees every name the decision answers to.
  expect(
    rows
      .at(0)
      ?.identifiers.map(({ value }) => value)
      .toSorted(),
  ).toEqual(["30 Cdo 400/2012", "Rc 55/2013"]);
});

test("an ECLI held only in the identifier rows resolves", async () => {
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "ecli", value: "ecli:cz:nss:2019:8.as.1.2019" },
  });

  expect(rows.map(({ id }) => id)).toEqual([administrativeId]);
});

test("a decision with several parallel identifiers is one candidate", async () => {
  // Matched by its own citation key while carrying two identifier rows: a
  // one-to-many join would report it two or three times and read as ambiguous.
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "docket", value: "23 Cdo 1572/2012" },
  });

  expect(rows.map(({ id }) => id)).toEqual([supremeId]);
});

test("the publication and redistribution gates apply to an identifier match", async () => {
  const listingOnly = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "docket", value: "2 Afs 2/2020" },
  });
  expect(listingOnly).toEqual([]);

  const restricted = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "docket", value: "4 Tdo 4/2021" },
  });
  expect(restricted).toEqual([]);

  // The same reference in another jurisdiction is another decision's.
  const elsewhere = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "SVK",
    locator: { kind: "docket", value: "30 Cdo 400/2012" },
  });
  expect(elsewhere).toEqual([]);
});
