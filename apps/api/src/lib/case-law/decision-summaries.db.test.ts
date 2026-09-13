/**
 * The gate every caller of the summaries read leans on.
 *
 * A question column's prompt suggestion and the answer runner both name
 * decisions by id and let this read decide which of them exist at all, so the
 * rule is proved here rather than restated at each caller: an id nobody
 * published and an id whose source withholds redistribution are both simply
 * absent from the answer, never an error and never a row with the text
 * blanked out.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_TEXT_FIELD } from "@stll/api-contract/case-law-text-field";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionSummaries } from "@/api/lib/case-law/decision-summaries";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const openId = createSafeId<"caseLawDecision">();
const closedId = createSafeId<"caseLawDecision">();
const unknownId = createSafeId<"caseLawDecision">();

const HEADNOTE = "Ušlý zisk se nahrazuje jen v prokázaném rozsahu.";

/** Same budget as the schema push below: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: a delegating view of the role transaction; the read only uses
      // its select surface.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = Object.create(roleTx) as CaseLawPublicReadTransaction;
      return await fn(tx);
    });
  // SAFETY: brand-only wrapper; the read never inspects the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db.insert(caseLawSources).values([
    caseLawSourceRow({ adapterKey: "open", id: openSourceId, name: "open" }),
    caseLawSourceRow({
      adapterKey: "closed",
      descriptor: {
        allowsDerivedAi: false,
        allowsRedistribution: false,
        attribution: null,
        license: "restricted",
      },
      id: closedSourceId,
      name: "closed",
    }),
  ]);
  await db.insert(caseLawDecisions).values([
    {
      caseNumber: "25 Cdo 1234/2021",
      country: "CZE",
      court: "Nejvyšší soud",
      id: openId,
      language: "cs",
      metadata: { [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: HEADNOTE },
      slug: "open-case",
      sourceId: openSourceId,
    },
    {
      caseNumber: "30 Cdo 99/2020",
      country: "CZE",
      court: "Nejvyšší soud",
      id: closedId,
      language: "cs",
      metadata: { [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: HEADNOTE },
      slug: "closed-case",
      sourceId: closedSourceId,
    },
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test("a redistributable decision comes back with its publisher headnote", async () => {
  const summaries = await readPublicDecisionSummaries({
    caseLawDb,
    decisionIds: [openId],
  });

  expect(summaries.map((summary) => summary.id)).toEqual([openId]);
  expect(summaries.at(0)?.headnote).toEqual({
    type: "present",
    text: HEADNOTE,
    truncated: false,
  });
});

test("a decision whose source withholds redistribution is skipped", async () => {
  // The row is there and carries a headnote, so an ungated read would return
  // it: the source's terms are the only reason it is absent.
  const summaries = await readPublicDecisionSummaries({
    caseLawDb,
    decisionIds: [openId, closedId],
  });

  expect(summaries.map((summary) => summary.id)).toEqual([openId]);
});

test("an id nobody published is skipped rather than refused", async () => {
  const summaries = await readPublicDecisionSummaries({
    caseLawDb,
    decisionIds: [unknownId, openId],
  });

  expect(summaries.map((summary) => summary.id)).toEqual([openId]);
});

test("naming only withheld and unknown decisions reads nothing", async () => {
  expect(
    await readPublicDecisionSummaries({
      caseLawDb,
      decisionIds: [closedId, unknownId],
    }),
  ).toEqual([]);
});
