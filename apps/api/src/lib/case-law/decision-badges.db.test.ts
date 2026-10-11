/**
 * Decision badges: a decision drawn as a compact reference.
 *
 * A badge exists only where the public reader would still serve the decision:
 * an id whose source withholds redistribution, or one nobody published, is
 * absent. A corpus that cannot be read is an error, never an empty answer, so
 * a caller can tell "nothing to draw" from "could not tell".
 */

import type { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import { readPublicDecisionBadges } from "./decision-badges";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const openId = createSafeId<"caseLawDecision">();
const closedId = createSafeId<"caseLawDecision">();
const unknownId = createSafeId<"caseLawDecision">();

/** Same budget as the schema push below: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const emptyRegistry = async () => await Promise.resolve(new Map());

const badgesOf = async (
  options: Parameters<typeof readPublicDecisionBadges>[0],
) => {
  const read = await readPublicDecisionBadges(options);
  if (Result.isError(read)) {
    throw read.error;
  }
  return read.value;
};

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
      decisionDate: "2021-03-12",
      id: openId,
      language: "cs",
      slug: "open-case",
      sourceId: openSourceId,
    },
    {
      caseNumber: "30 Cdo 99/2020",
      country: "CZE",
      court: "Nejvyšší soud",
      id: closedId,
      language: "cs",
      slug: "closed-case",
      sourceId: closedSourceId,
    },
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test("a published decision comes back with what its badge draws", async () => {
  const decisions = await badgesOf({
    caseLawDb,
    // Two references to one decision read it once.
    decisionIds: [openId, openId],
    readCourtWeights: emptyRegistry,
  });

  expect([...decisions.keys()]).toEqual([openId]);
  expect(decisions.get(openId)).toEqual({
    caseNumber: "25 Cdo 1234/2021",
    country: "CZE",
    court: "Nejvyšší soud",
    courtAbbreviation: "NS",
    courtTier: expect.any(String),
    decisionDate: "2021-03-12",
    id: openId,
    language: "cs",
    languageAlternates: [],
    slug: "open-case",
  });
});

test("a withheld or unknown decision is absent, not an error", async () => {
  const decisions = await badgesOf({
    caseLawDb,
    decisionIds: [closedId, unknownId],
    readCourtWeights: emptyRegistry,
  });

  expect(decisions.size).toBe(0);
});

test("no decisions to read is no read at all", async () => {
  let reads = 0;
  const countingDb = Object.assign(
    async <T>(fn: (tx: CaseLawPublicReadTransaction) => Promise<T>) => {
      reads += 1;
      return await caseLawDb(fn);
    },
    caseLawDb,
  );

  const decisions = await badgesOf({
    caseLawDb: countingDb,
    decisionIds: [],
    readCourtWeights: emptyRegistry,
  });

  expect(decisions.size).toBe(0);
  expect(reads).toBe(0);
});

test("an unreadable corpus is an error, not an empty answer", async () => {
  const failingDb = Object.assign(
    async () => await Promise.reject(new Error("corpus unavailable")),
    caseLawDb,
  );

  const read = await readPublicDecisionBadges({
    caseLawDb: failingDb,
    decisionIds: [openId],
    readCourtWeights: emptyRegistry,
  });

  expect(Result.isError(read)).toBe(true);
});

test("an unreadable court registry draws the decision without its chip", async () => {
  const decisions = await badgesOf({
    caseLawDb,
    decisionIds: [openId],
    readCourtWeights: async () =>
      await Promise.reject(new Error("registry unavailable")),
  });

  expect(decisions.get(openId)?.courtAbbreviation).toBeNull();
  expect(decisions.get(openId)?.caseNumber).toBe("25 Cdo 1234/2021");
});
