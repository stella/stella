import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { readCaseLawSearchTextForAi } from "@/api/lib/case-law/search-sql";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const displayOnlySourceId = createSafeId<"caseLawSource">();
const liveDecisionId = createSafeId<"caseLawDecision">();
const withdrawnDecisionId = createSafeId<"caseLawDecision">();
const closedSourceDecisionId = createSafeId<"caseLawDecision">();
const displayOnlyDecisionId = createSafeId<"caseLawDecision">();

let client: PGlite;
let db: ReturnType<typeof drizzle>;

const readText = async (decisionId: typeof liveDecisionId) =>
  await readCaseLawSearchTextForAi(asTestRaw<Transaction>(db), decisionId);

// timeout: embedded PostgreSQL builds the complete migration schema for this test.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
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
    caseLawSourceRow({
      adapterKey: "display-only",
      descriptor: {
        allowsDerivedAi: false,
        allowsRedistribution: true,
        attribution: null,
        license: "permitted-redistribution",
      },
      id: displayOnlySourceId,
      name: "display-only",
    }),
  ]);
  const decisions = [
    { id: liveDecisionId, sourceId: openSourceId, caseNumber: "1 A 1/2026" },
    {
      id: withdrawnDecisionId,
      sourceId: openSourceId,
      caseNumber: "2 A 2/2026",
    },
    {
      id: closedSourceDecisionId,
      sourceId: closedSourceId,
      caseNumber: "3 A 3/2026",
    },
    {
      id: displayOnlyDecisionId,
      sourceId: displayOnlySourceId,
      caseNumber: "4 A 4/2026",
    },
  ];
  await db.insert(caseLawDecisions).values(
    decisions.map((decision) => ({
      ...decision,
      country: "CZE",
      court: "Synthetic court",
      language: "cs",
    })),
  );
  await db.insert(caseLawSearchDocuments).values(
    decisions.map(({ id }) => ({
      decisionId: id,
      language: "cs",
      regconfig: "simple",
      searchableText: `body of ${id}`,
      tsv: sql`to_tsvector('simple', 'body')`,
    })),
  );
}, 120_000);

afterAll(async () => {
  await client.close();
});

test("a published decision from a redistributable source yields its text", async () => {
  expect(await readText(liveDecisionId)).toBe(`body of ${liveDecisionId}`);
});

test("a withdrawn decision contributes no text to a search summary", async () => {
  expect(await readText(withdrawnDecisionId)).toBe(
    `body of ${withdrawnDecisionId}`,
  );
  await db
    .update(caseLawDecisions)
    .set({ redactedAt: new Date("2026-02-01T00:00:00.000Z") })
    .where(eq(caseLawDecisions.id, withdrawnDecisionId));
  expect(await readText(withdrawnDecisionId)).toBeNull();
});

test("a decision from a non-redistributable source contributes no text", async () => {
  expect(await readText(closedSourceDecisionId)).toBeNull();
});

test("a decision from a redistributable source that forbids derived AI contributes no text", async () => {
  expect(await readText(displayOnlyDecisionId)).toBeNull();
});

test("a decision without a projection row yields no text", async () => {
  expect(await readText(createSafeId<"caseLawDecision">())).toBeNull();
});
