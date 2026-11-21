import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import {
  reopenCitationsForDecisionIdentifiers,
  reopenCitationsForDecisionKey,
  resolveCitationsForDecision,
} from "@/api/handlers/case-law/citation-resolution";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * A docket key is stored as its publisher printed it, and one case is printed
 * with its year in four digits or in two. The resolver compares match keys,
 * so a citation reaches its holder whichever form each side printed: through
 * the decision's own key and through its identifier rows, forwards, and in
 * reverse when the holder arrives after the citation gave up on it. Two cases
 * that differ beyond the year still never link.
 *
 * Mutation: with the holder joins comparing raw keys again, every positive
 * case fails and every negative one still passes.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const euSource = createSafeId<"caseLawSource">();
const polSource = createSafeId<"caseLawSource">();
const czSource = createSafeId<"caseLawSource">();

// The citing judgments: a Polish one citing the Court of Justice, and a Czech
// one citing a Czech court.
const polCiting = createSafeId<"caseLawDecision">();
const czCiting = createSafeId<"caseLawDecision">();

// Court of Justice holders, stored with the two-digit year it prints.
const euByKey = createSafeId<"caseLawDecision">();
const euByIdentifier = createSafeId<"caseLawDecision">();
// A Czech holder stored with the four-digit year its court prints.
const czByKey = createSafeId<"caseLawDecision">();

const fourDigitCitation = createSafeId<"caseLawCitation">();
const identifierCitation = createSafeId<"caseLawCitation">();
const twoDigitCitation = createSafeId<"caseLawCitation">();
const otherNumberCitation = createSafeId<"caseLawCitation">();
const otherYearCitation = createSafeId<"caseLawCitation">();
const lateKeyCitation = createSafeId<"caseLawCitation">();
const lateIdentifierCitation = createSafeId<"caseLawCitation">();

const decision = (
  id: SafeId<"caseLawDecision">,
  fields: {
    sourceId: SafeId<"caseLawSource">;
    country: string;
    caseNumber: string;
    citationKey: string | null;
    decisionDate: string;
    language: string;
  },
) => ({
  ...fields,
  id,
  court: fields.country === "EU" ? "Court of Justice" : "Test court",
  fulltext: "text",
  sourceDocumentId: id,
  slug: id,
  languageGroupKey: id,
});

const citationOf = (
  id: SafeId<"caseLawCitation">,
  citingDecisionId: SafeId<"caseLawDecision">,
  printed: string,
  key: string,
) => ({
  id,
  citingDecisionId,
  citationText: printed,
  citationKey: key,
  identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  normalizedIdentifierValue: key,
});

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values([
      { id: euSource, adapterKey: "eu-ecj", name: "court of justice" },
      { id: polSource, adapterKey: "pl-courts", name: "polish courts" },
      { id: czSource, adapterKey: "cz-ns", name: "czech court" },
    ]);

    await db.insert(caseLawDecisions).values([
      decision(polCiting, {
        sourceId: polSource,
        country: "POL",
        caseNumber: "I ACa 1/2023",
        citationKey: "iaca/1/2023",
        decisionDate: "2023-03-01",
        language: "pl",
      }),
      decision(czCiting, {
        sourceId: czSource,
        country: "CZE",
        caseNumber: "33 Cdo 1/2023",
        citationKey: "33cdo/1/2023",
        decisionDate: "2023-03-01",
        language: "cs",
      }),
      decision(euByKey, {
        sourceId: euSource,
        country: "EU",
        caseNumber: "C-679/18",
        citationKey: "c-679/18",
        decisionDate: "2019-10-01",
        language: "en",
      }),
      // Known under its ECLI; the docket is an identifier row only.
      decision(euByIdentifier, {
        sourceId: euSource,
        country: "EU",
        caseNumber: "ECLI:EU:C:2018:501",
        citationKey: null,
        decisionDate: "2018-06-01",
        language: "en",
      }),
      decision(czByKey, {
        sourceId: czSource,
        country: "CZE",
        caseNumber: "44 Cdo 77/2016",
        citationKey: "44cdo/77/2016",
        decisionDate: "2016-09-01",
        language: "cs",
      }),
    ]);

    await db.insert(caseLawDecisionIdentifiers).values({
      decisionId: euByIdentifier,
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: "C-555/17",
      normalizedValue: "c-555/17",
    });

    await db
      .insert(caseLawCitations)
      .values([
        citationOf(fourDigitCitation, polCiting, "C-679/2018", "c-679/2018"),
        citationOf(identifierCitation, polCiting, "C-555/2017", "c-555/2017"),
        citationOf(twoDigitCitation, czCiting, "44 Cdo 77/16", "44cdo/77/16"),
        citationOf(otherNumberCitation, polCiting, "C-697/2018", "c-697/2018"),
        citationOf(otherYearCitation, polCiting, "C-679/2019", "c-679/2019"),
        citationOf(lateKeyCitation, polCiting, "C-920/2020", "c-920/2020"),
        citationOf(
          lateIdentifierCitation,
          czCiting,
          "44 Cdo 9/2021",
          "44cdo/9/2021",
        ),
      ]);

    for (const citing of [polCiting, czCiting]) {
      // db-await-in-loop: the two citing decisions settle in turn
      await runCitationGraphTransaction(db.transaction.bind(db), async (tx) =>
        resolveCitationsForDecision(tx, citing),
      );
    }
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const rowOf = async (id: SafeId<"caseLawCitation">) => {
  const rows = await db
    .select({
      cited: caseLawCitations.citedDecisionId,
      status: caseLawCitations.resolutionStatus,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, id))
    .limit(1);
  return rows.at(0) ?? null;
};

const resolvedTo = (cited: SafeId<"caseLawDecision">) => ({
  cited,
  status: CITATION_RESOLUTION_STATUS.RESOLVED,
});

const UNMATCHED = { cited: null, status: CITATION_RESOLUTION_STATUS.UNMATCHED };

test("a four-digit printing reaches the holder stored with two", async () => {
  expect(await rowOf(fourDigitCitation)).toEqual(resolvedTo(euByKey));
});

test("a four-digit printing reaches a holder that carries the docket as an identifier", async () => {
  expect(await rowOf(identifierCitation)).toEqual(resolvedTo(euByIdentifier));
});

test("a two-digit printing reaches the holder stored with four", async () => {
  expect(await rowOf(twoDigitCitation)).toEqual(resolvedTo(czByKey));
});

test("a case that differs beyond the year printing links nothing", async () => {
  expect(await rowOf(otherNumberCitation)).toEqual(UNMATCHED);
  expect(await rowOf(otherYearCitation)).toEqual(UNMATCHED);
});

test("a holder arriving under its key reopens and answers a citation printed the other way", async () => {
  expect(await rowOf(lateKeyCitation)).toEqual(UNMATCHED);
  const arrived = createSafeId<"caseLawDecision">();
  const reopened = await runCitationGraphTransaction(
    db.transaction.bind(db),
    async (tx) => {
      await tx.insert(caseLawDecisions).values(
        decision(arrived, {
          sourceId: euSource,
          country: "EU",
          caseNumber: "C-920/20",
          citationKey: "c-920/20",
          decisionDate: "2021-04-01",
          language: "en",
        }),
      );
      return await reopenCitationsForDecisionKey(tx, {
        citationKey: "c-920/20",
        decisionId: arrived,
        jurisdiction: "EU",
        decisionDate: "2021-04-01",
      });
    },
  );
  expect(reopened).toBe(1);
  expect(await rowOf(lateKeyCitation)).toMatchObject({
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });
  await runCitationGraphTransaction(db.transaction.bind(db), async (tx) =>
    resolveCitationsForDecision(tx, polCiting),
  );
  expect(await rowOf(lateKeyCitation)).toEqual(resolvedTo(arrived));
  // Nothing else the Polish judgment cites changed its answer.
  expect(await rowOf(otherNumberCitation)).toEqual(UNMATCHED);
  expect(await rowOf(fourDigitCitation)).toEqual(resolvedTo(euByKey));
});

test("a holder arriving with an identifier reopens and answers a citation printed the other way", async () => {
  expect(await rowOf(lateIdentifierCitation)).toEqual(UNMATCHED);
  const arrived = createSafeId<"caseLawDecision">();
  const reopened = await runCitationGraphTransaction(
    db.transaction.bind(db),
    async (tx) => {
      await tx.insert(caseLawDecisions).values(
        decision(arrived, {
          sourceId: czSource,
          country: "CZE",
          caseNumber: "44 Cdo 9/21",
          citationKey: "44cdo/9/21",
          decisionDate: "2021-11-01",
          language: "cs",
        }),
      );
      await tx.insert(caseLawDecisionIdentifiers).values({
        decisionId: arrived,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "44 Cdo 9/21",
        normalizedValue: "44cdo/9/21",
      });
      return await reopenCitationsForDecisionIdentifiers(tx, {
        identifiers: [
          {
            type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
            normalizedValue: "44cdo/9/21",
          },
        ],
        decisionId: arrived,
        jurisdiction: "CZE",
        decisionDate: "2021-11-01",
      });
    },
  );
  expect(reopened.reopened).toBe(1);
  expect(reopened.citationIds).toEqual([lateIdentifierCitation]);
  await runCitationGraphTransaction(db.transaction.bind(db), async (tx) =>
    resolveCitationsForDecision(tx, czCiting),
  );
  expect(await rowOf(lateIdentifierCitation)).toEqual(resolvedTo(arrived));
  expect(await rowOf(twoDigitCitation)).toEqual(resolvedTo(czByKey));
});
