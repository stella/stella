import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_DECISION_TYPE_HINT } from "@/api/handlers/case-law/citation-decision-type-hint";
import { resolveCitationsForDecision } from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_RESOLUTION_RULE,
  CITATION_RESOLUTION_STATUS,
} from "@/api/handlers/case-law/citation-resolution-status";
import {
  bareCitationKey,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * One docket, several decisions: an administrative court keeps `8 As 287/2020`
 * for a whole case file and rules in it more than once, so uniqueness alone
 * links none of them. What the citing sentence adds to the docket is what
 * identifies the decision — the sheet the document sits on, or its date — and
 * each case below is a shape those two rules must decide one way and no other.
 *
 * Identity is read from the database here (an ECLI's last segment, a
 * publisher's parallel file number, a stored decision date), so the rules are
 * join predicates rather than branches a unit test could reach.
 *
 * Mutation: with the `sheet_matched` arm removed from the statement the first
 * two tests fail and every negative case still passes, so the negatives alone
 * would not notice the rule being absent; the same holds for `date_matched`
 * and the fourth test.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const citing = createSafeId<"caseLawDecision">();
// Sheet 33 and sheet 41 were both decided on one day; sheet 48 a month later.
const sheet33 = createSafeId<"caseLawDecision">();
const sheet41 = createSafeId<"caseLawDecision">();
const sheet48 = createSafeId<"caseLawDecision">();

const bySheetCitation = createSafeId<"caseLawCitation">();
const byIdentifierSheetCitation = createSafeId<"caseLawCitation">();
const byUnknownSheetCitation = createSafeId<"caseLawCitation">();
const byDateCitation = createSafeId<"caseLawCitation">();
const bySharedDateCitation = createSafeId<"caseLawCitation">();
const byDocketAloneCitation = createSafeId<"caseLawCitation">();
const sharedDateWithHintCitation = createSafeId<"caseLawCitation">();
const sheetOverDateCitation = createSafeId<"caseLawCitation">();

const DOCKET = "8 As 287/2020";
const DOCKET_KEY = bareCitationKey(DOCKET);

// The pglite handle stands in for a transaction, matching the pattern the
// other case-law database tests use for their fakes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const asTx = () => db as unknown as Transaction;

const court = {
  sourceId,
  court: "Nejvyšší správní soud",
  country: "CZE",
  language: "cs",
  fulltext: "text",
  decisionType: "rozsudek",
};

const fileDecision = (
  id: SafeId<"caseLawDecision">,
  fields: {
    decisionDate: string;
    decisionType?: string;
    ecli: string | null;
  },
) => ({
  ...court,
  ...fields,
  id,
  caseNumber: DOCKET,
  citationKey: DOCKET_KEY,
  // One file publishes several documents under one number, told apart by the
  // publisher's own id.
  sourceDocumentId: id,
  slug: id,
  languageGroupKey: id,
});

const citation = (
  id: SafeId<"caseLawCitation">,
  fields: {
    citedSheetNumber?: string;
    citedDecisionDate?: string;
    citedDecisionTypeHint?: string;
  },
) => ({
  ...fields,
  id,
  citingDecisionId: citing,
  citationText: `č. j. ${DOCKET}`,
  citationKey: DOCKET_KEY,
  identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  normalizedIdentifierValue: DOCKET_KEY,
});

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });

  await db
    .insert(caseLawSources)
    .values([
      { id: sourceId, adapterKey: "cz-nss", name: "administrative court" },
    ]);

  await db.insert(caseLawDecisions).values([
    {
      ...court,
      id: citing,
      caseNumber: "1 Afs 1/2022",
      citationKey: bareCitationKey("1 Afs 1/2022"),
      decisionDate: "2022-05-01",
      sourceDocumentId: citing,
      slug: citing,
      languageGroupKey: citing,
    },
    fileDecision(sheet33, {
      decisionDate: "2021-02-17",
      ecli: "ECLI:CZ:NSS:2021:8.As.287.2020.33",
    }),
    // No ECLI: this publisher states the sheet on a parallel file number
    // instead, which ingestion keeps as a `case-number` identifier row.
    fileDecision(sheet41, { decisionDate: "2021-02-17", ecli: null }),
    fileDecision(sheet48, {
      decisionDate: "2021-03-25",
      // The only order in the file; the other two are judgments.
      decisionType: CITATION_DECISION_TYPE_HINT.ORDER,
      ecli: "ECLI:CZ:NSS:2021:8.As.287.2020.48",
    }),
  ]);

  await db.insert(caseLawDecisionIdentifiers).values([
    {
      decisionId: sheet41,
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: `${DOCKET}-41`,
      normalizedValue: normalizeDecisionIdentifierValue(
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        `${DOCKET}-41`,
      ),
    },
  ]);

  await db.insert(caseLawCitations).values([
    citation(bySheetCitation, { citedSheetNumber: "33" }),
    citation(byIdentifierSheetCitation, { citedSheetNumber: "41" }),
    citation(byUnknownSheetCitation, { citedSheetNumber: "99" }),
    citation(byDateCitation, { citedDecisionDate: "2021-03-25" }),
    citation(bySharedDateCitation, { citedDecisionDate: "2021-02-17" }),
    citation(byDocketAloneCitation, {}),
    // The sentence dates the citation to the day two decisions share, and
    // separately names a type only the third decision has.
    citation(sharedDateWithHintCitation, {
      citedDecisionDate: "2021-02-17",
      citedDecisionTypeHint: CITATION_DECISION_TYPE_HINT.ORDER,
    }),
    citation(sheetOverDateCitation, {
      citedSheetNumber: "33",
      citedDecisionDate: "2021-03-25",
    }),
  ]);
});

afterAll(async () => {
  await client.close();
});

const rowOf = async (id: SafeId<"caseLawCitation">) => {
  const rows = await db
    .select({
      cited: caseLawCitations.citedDecisionId,
      status: caseLawCitations.resolutionStatus,
      rule: caseLawCitations.resolutionRuleId,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, id))
    .limit(1);
  return rows.at(0) ?? null;
};

const resolved = (cited: SafeId<"caseLawDecision">, rule: string) => ({
  cited,
  rule,
  status: CITATION_RESOLUTION_STATUS.RESOLVED,
});

const AMBIGUOUS = {
  cited: null,
  rule: null,
  status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
};

test("the sheet a text names picks the decision out of its case file", async () => {
  const counts = await resolveCitationsForDecision(asTx(), citing);

  expect(counts.resolvedByRule).toMatchObject({
    [CITATION_RESOLUTION_RULE.SHEET_NUMBER]: 3,
    [CITATION_RESOLUTION_RULE.DECISION_DATE]: 1,
  });
  expect(counts.ambiguous).toBe(4);

  // The sheet is the last segment of the decision's ECLI.
  expect(await rowOf(bySheetCitation)).toEqual(
    resolved(sheet33, CITATION_RESOLUTION_RULE.SHEET_NUMBER),
  );
  // The same sheet, stated by the publisher as a parallel file number.
  expect(await rowOf(byIdentifierSheetCitation)).toEqual(
    resolved(sheet41, CITATION_RESOLUTION_RULE.SHEET_NUMBER),
  );
  // A sheet is more specific than a date, so it decides where both are named.
  expect(await rowOf(sheetOverDateCitation)).toEqual(
    resolved(sheet33, CITATION_RESOLUTION_RULE.SHEET_NUMBER),
  );
});

test("a date decides where no sheet was printed", async () => {
  expect(await rowOf(byDateCitation)).toEqual(
    resolved(sheet48, CITATION_RESOLUTION_RULE.DECISION_DATE),
  );
});

test("a sheet no candidate answers to is a number the corpus cannot use", async () => {
  expect(await rowOf(byUnknownSheetCitation)).toEqual(AMBIGUOUS);
});

test("two decisions of one file on one day stay ambiguous", async () => {
  expect(await rowOf(bySharedDateCitation)).toEqual(AMBIGUOUS);
});

test("the docket alone still names the file rather than a decision", async () => {
  expect(await rowOf(byDocketAloneCitation)).toEqual(AMBIGUOUS);
});

test("a word cannot pick a decision the named date excluded", async () => {
  // The date narrowed the file to two decisions without naming one of them,
  // and the type the sentence names belongs to neither. Taking the link on
  // the type word would contradict the citing court's own date, so the row
  // stays ambiguous.
  expect(await rowOf(sharedDateWithHintCitation)).toEqual(AMBIGUOUS);
});
