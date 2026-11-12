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
  CITATION_ARRIVAL_SETTLE_CAP,
  reopenCitationsForDecisionIdentifiers,
  settleReopenedCitations,
} from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_RESOLUTION_RULE,
  CITATION_RESOLUTION_STATUS,
} from "@/api/handlers/case-law/citation-resolution-status";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * A citation written before the decision it names is stored cannot be linked
 * when it is written. These cases hold the other half: the write that stores
 * the named decision answers the citations waiting for it, by the resolver's
 * own doctrine, so none of them waits for the standing walk.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const citing = createSafeId<"caseLawDecision">();

const base = {
  sourceId,
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  fulltext: "text",
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db
    .insert(caseLawSources)
    .values({ id: sourceId, adapterKey: "cz-ns", name: "arrival settle" });
  await db.insert(caseLawDecisions).values({
    ...base,
    id: citing,
    caseNumber: "23 Cdo 1/2022",
    citationKey: "23cdo/1/2022",
    decisionDate: "2022-06-01",
    slug: "arrival-citing",
    languageGroupKey: "arrival-citing",
  });
});

afterAll(async () => {
  await client.close();
});

type Arrival = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  key: string;
  decisionDate: string;
};

/** Store a decision and its identifier as a row write does, then announce it. */
const storeArrival = async ({ id, caseNumber, key, decisionDate }: Arrival) =>
  await runCitationGraphTransaction(db.transaction.bind(db), async (tx) => {
    await tx.insert(caseLawDecisions).values({
      ...base,
      id,
      caseNumber,
      citationKey: key,
      decisionDate,
      slug: `arrival-${id}`,
      languageGroupKey: `arrival-${id}`,
    });
    await tx.insert(caseLawDecisionIdentifiers).values({
      decisionId: id,
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: caseNumber,
      normalizedValue: key,
    });
    const reopened = await reopenCitationsForDecisionIdentifiers(tx, {
      identifiers: [
        { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, normalizedValue: key },
      ],
      decisionId: id,
      jurisdiction: "CZE",
      decisionDate,
    });
    return {
      reopened,
      settled: await settleReopenedCitations(tx, [reopened]),
    };
  });

const waitingCitation = (key: string, text: string) => ({
  id: createSafeId<"caseLawCitation">(),
  citingDecisionId: citing,
  citationText: text,
  citationKey: key,
  identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  normalizedIdentifierValue: key,
  resolutionStatus: CITATION_RESOLUTION_STATUS.UNMATCHED,
  resolutionAttemptedAt: new Date("2026-11-01T10:00:00.000Z"),
});

const rowOf = async (id: SafeId<"caseLawCitation">) =>
  (
    await db
      .select({
        cited: caseLawCitations.citedDecisionId,
        status: caseLawCitations.resolutionStatus,
        rule: caseLawCitations.resolutionRuleId,
      })
      .from(caseLawCitations)
      .where(eq(caseLawCitations.id, id))
      .limit(1)
  ).at(0);

test("a citation is linked by the write that stores the decision it names", async () => {
  const key = "21cdo/5302/2016";
  const citation = waitingCitation(key, "sp. zn. 21 Cdo 5302/2016");
  await db.insert(caseLawCitations).values(citation);
  const target = createSafeId<"caseLawDecision">();

  const { reopened, settled } = await storeArrival({
    id: target,
    caseNumber: "21 Cdo 5302/2016",
    key,
    decisionDate: "2017-08-17",
  });

  expect(reopened).toEqual({ reopened: 1, citationIds: [citation.id] });
  expect(settled).toMatchObject({ scanned: 1, resolved: 1 });
  expect(await rowOf(citation.id)).toEqual({
    cited: target,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
    rule: CITATION_RESOLUTION_RULE.UNIQUE_KEY,
  });
});

test("a second holder of the key retracts the first link in the same write", async () => {
  const key = "29cdo/61/2017";
  const citation = waitingCitation(key, "sp. zn. 29 Cdo 61/2017");
  await db.insert(caseLawCitations).values(citation);
  const first = createSafeId<"caseLawDecision">();
  await storeArrival({
    id: first,
    caseNumber: "29 Cdo 61/2017",
    key,
    decisionDate: "2017-10-31",
  });
  expect(await rowOf(citation.id)).toMatchObject({ cited: first });

  const { settled } = await storeArrival({
    id: createSafeId<"caseLawDecision">(),
    caseNumber: "29 Cdo 61/2017",
    key,
    decisionDate: "2018-01-15",
  });

  // Two holders and nothing in the citation that tells them apart: unlinked,
  // with the reason, rather than left pointing at whichever came first.
  expect(settled).toMatchObject({ scanned: 1, ambiguous: 1 });
  expect(await rowOf(citation.id)).toEqual({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
    rule: null,
  });
});

test("a decision published after the citing one is not linked to it", async () => {
  const key = "32cdo/9/2023";
  const citation = waitingCitation(key, "sp. zn. 32 Cdo 9/2023");
  await db.insert(caseLawCitations).values(citation);

  const { reopened } = await storeArrival({
    id: createSafeId<"caseLawDecision">(),
    caseNumber: "32 Cdo 9/2023",
    key,
    decisionDate: "2023-03-01",
  });

  expect(reopened.reopened).toBe(0);
  expect(await rowOf(citation.id)).toEqual({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
    rule: null,
  });
});

test("a write settles at most the cap and leaves the rest to the walk", async () => {
  const key = "33cdo/99/2020";
  const citations = Array.from(
    { length: CITATION_ARRIVAL_SETTLE_CAP + 3 },
    () => waitingCitation(key, "sp. zn. 33 Cdo 99/2020"),
  );
  await db.insert(caseLawCitations).values(citations);
  const target = createSafeId<"caseLawDecision">();

  const { reopened, settled } = await storeArrival({
    id: target,
    caseNumber: "33 Cdo 99/2020",
    key,
    decisionDate: "2020-06-23",
  });

  expect(reopened.reopened).toBe(citations.length);
  expect(reopened.citationIds).toHaveLength(CITATION_ARRIVAL_SETTLE_CAP);
  expect(settled).toMatchObject({
    scanned: CITATION_ARRIVAL_SETTLE_CAP,
    resolved: CITATION_ARRIVAL_SETTLE_CAP,
  });
  const rows = await db
    .select({
      status: caseLawCitations.resolutionStatus,
      cited: caseLawCitations.citedDecisionId,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citationKey, key));
  expect(
    rows.filter(
      (row) =>
        row.status === CITATION_RESOLUTION_STATUS.RESOLVED &&
        row.cited === target,
    ),
  ).toHaveLength(CITATION_ARRIVAL_SETTLE_CAP);
  expect(
    rows.filter((row) => row.status === CITATION_RESOLUTION_STATUS.PENDING),
  ).toHaveLength(3);
});
