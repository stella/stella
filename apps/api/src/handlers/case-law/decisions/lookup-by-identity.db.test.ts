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
  normalizeDecisionIdentifierValueIn,
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
const reportedId = createSafeId<"caseLawDecision">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

/** A row as ingestion writes it for a decision of `jurisdiction`. */
const identifierRow = ({
  decisionId,
  jurisdiction = "CZE",
  type,
  value,
}: {
  decisionId: (typeof caseLawDecisionIdentifiers.$inferInsert)["decisionId"];
  jurisdiction?: string;
  type: DecisionIdentifierType;
  value: string;
}) => ({
  decisionId,
  type,
  value,
  normalizedValue: normalizeDecisionIdentifierValueIn(
    jurisdiction,
    type,
    value,
  ),
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
      {
        id: reportedId,
        sourceId: openSourceId,
        caseNumber: "1",
        citationKey: citationKeyOf("1"),
        court: "Supreme Court",
        country: "USA",
        decisionDate: "1954-05-17",
        language: "cs",
        languageGroupKey: "lookup-reported",
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
      // Reporter citations as a publisher spaced and abbreviated them, and a
      // neutral citation.
      identifierRow({
        decisionId: reportedId,
        jurisdiction: "USA",
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "347 U. S. 483",
      }),
      identifierRow({
        decisionId: reportedId,
        jurisdiction: "USA",
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "98 Law. Ed. 873",
      }),
      identifierRow({
        decisionId: reportedId,
        jurisdiction: "USA",
        type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
        value: "[1954] SC 7",
      }),
      // A reporter-type identifier of another jurisdiction keeps its own key.
      identifierRow({
        decisionId: administrativeId,
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "10 Atl. 5",
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

test("a reporter citation resolves however the query spaces or abbreviates it, pin and all", async () => {
  for (const value of [
    "347 U.S. 483",
    "347 U. S. 483, 495",
    "98 L. Ed. 873",
    "98 L.Ed. 873, at 880",
    "347 u.s. 483",
    "347 U.S. 483, 495, 497",
    "347 U.S. 483 at 495",
  ]) {
    const rows = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "USA",
      locator: { kind: "reporter", value },
    });
    expect(rows.map(({ id }) => id)).toEqual([reportedId]);
  }

  // The first page is identity; the next page is another decision.
  const neighbour = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "USA",
    locator: { kind: "reporter", value: "347 U.S. 484" },
  });
  expect(neighbour).toEqual([]);
});

test("a reporter-type identifier elsewhere keeps the key it always had", async () => {
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "reporter", value: "Rc 55/2013" },
  });
  expect(rows.map(({ id }) => id)).toEqual([supremeId]);

  // Read as written there: not rewritten into another jurisdiction's edition.
  const asWritten = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "reporter", value: "10 Atl. 5" },
  });
  expect(asWritten.map(({ id }) => id)).toEqual([administrativeId]);
  const asCanonicalEdition = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "reporter", value: "10 A. 5" },
  });
  expect(asCanonicalEdition).toEqual([]);
});

test("a typed reference resolves only through identifiers of its own type", async () => {
  const neutral = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "USA",
    locator: { kind: "neutral", value: "[1954] sc 7" },
  });
  expect(neutral.map(({ id }) => id)).toEqual([reportedId]);
  expect(
    neutral
      .at(0)
      ?.identifiers.map(({ type }) => type)
      .toSorted(),
  ).toEqual([
    DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
    DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  ]);

  const neutralAsReporter = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "USA",
    locator: { kind: "reporter", value: "[1954] SC 7" },
  });
  expect(neutralAsReporter).toEqual([]);

  const reporterAsDocket = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "USA",
    locator: { kind: "docket", value: "347 U.S. 483" },
  });
  expect(reporterAsDocket).toEqual([]);
});
