import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import {
  planDecisionReviews,
  writeDecisionReviews,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-reviews";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

const MIGRATION =
  "../../../../../drizzle/20261028173000_case_law_decision_reviews/migration.sql";
const REVIEWING = toSafeId<"caseLawDecision">(
  "019dd78d-2e0c-7000-955a-63d713b246ba",
);
const REVIEWED = toSafeId<"caseLawDecision">(
  "01a03050-4387-76b6-aae3-4b05db9a0238",
);
const reviews = () =>
  planDecisionReviews({
    country: "CZE",
    metadata: {},
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "Nejvyšší správní soud rozhodl v řízení o kasační stížnosti žalobců proti rozsudku Krajského soudu v Ostravě ze dne 16. 1. 2025, č. j. 25 A 20/2024-35, takto:",
      },
      {
        index: 1,
        type: "ruling",
        title: null,
        text: "Kasační stížnost se zamítá.",
      },
    ],
  });
const prepare = async () => {
  const client = await PGlite.create();
  await client.exec(`
    CREATE ROLE stella; CREATE ROLE stella_ingestion;
    CREATE ROLE stella_caselaw_reader; CREATE ROLE stella_public_law_reader;
    CREATE TABLE case_law_decisions (
      id uuid PRIMARY KEY, country text NOT NULL, court text NOT NULL,
      case_number text NOT NULL, docket_family_key text, decision_date date,
      sheet_number text, ecli text, redacted_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'
    );
  `);
  await client.exec(await Bun.file(new URL(MIGRATION, import.meta.url)).text());
  return client;
};
type Db = ReturnType<typeof drizzle>;
type Decision = {
  id: SafeId<"caseLawDecision">;
  court?: string;
  date?: string;
  sheet?: string;
  family?: string;
};
const insertDecision = async (
  db: Db,
  {
    id,
    court = "Krajský soud v Ostravě",
    date = "2025-01-16",
    sheet = "35",
    family = "reviewing",
  }: Decision,
) => {
  await db.execute(sql`INSERT INTO case_law_decisions
    (id, country, court, case_number, docket_family_key, decision_date, sheet_number)
    VALUES (${id}::uuid, 'CZE', ${court}, '25 A 20/2024', ${family}, ${date}::date, ${sheet})`);
};
type ApplyOptions = {
  db: Db;
  id: SafeId<"caseLawDecision">;
  plan: ReturnType<typeof reviews>;
  country?: string;
  previousCountry?: string;
};
const apply = async ({
  db,
  id,
  plan,
  country = "CZE",
  previousCountry = country,
}: ApplyOptions) =>
  await runCitationGraphTransaction(
    (run) => db.transaction(run),
    (tx) =>
      writeDecisionReviews(tx, {
        decisionId: id,
        country,
        previousCountry,
        reviews: plan,
      }),
  );
const links = async (client: PGlite) =>
  (
    await client.query(
      "SELECT * FROM case_law_decision_reviews ORDER BY reviewing_decision_id",
    )
  ).rows;

test("the public NSS/KS pair converges under replay and links a later target arrival", async () => {
  await using client = await prepare();
  const db = drizzle({ client });
  const planned = reviews();
  expect(planned).toHaveLength(1);
  const target =
    planned?.at(0) ?? panic("The public opening fixture must extract a review");
  expect(target.outcome).toBe("upheld");
  await insertDecision(db, { id: REVIEWING, court: "Nejvyšší správní soud" });
  await apply({ db, id: REVIEWING, plan: planned });
  expect((await links(client)).at(0)).toHaveProperty(
    "reviewed_decision_id",
    null,
  );
  await insertDecision(db, {
    id: REVIEWED,
    family: target.reviewedDocketFamilyKey,
  });
  await apply({ db, id: REVIEWED, plan: null });
  expect((await links(client)).at(0)).toHaveProperty(
    "reviewed_decision_id",
    REVIEWED,
  );
  const first = await links(client);
  const physical = await client.query(
    "SELECT xmin::text, ctid::text FROM case_law_decision_reviews",
  );
  await apply({ db, id: REVIEWING, plan: planned });
  await apply({ db, id: REVIEWING, plan: planned });
  expect(await links(client)).toEqual(first);
  expect(
    (
      await client.query(
        "SELECT xmin::text, ctid::text FROM case_law_decision_reviews",
      )
    ).rows,
  ).toEqual(physical.rows);
  expect(
    (
      await client.query(
        "SELECT review_extraction_version FROM case_law_decisions WHERE id = $1",
        [REVIEWING],
      )
    ).rows,
  ).toEqual([{ review_extraction_version: 1 }]);
});

test("same dockets at another court, date or sheet cannot receive a review edge", async () => {
  await using client = await prepare();
  const db = drizzle({ client });
  const planned = reviews();
  const target =
    planned?.at(0) ?? panic("The public opening fixture must extract a review");
  const family = target.reviewedDocketFamilyKey;
  await insertDecision(db, { id: REVIEWING, court: "Nejvyšší správní soud" });
  await insertDecision(db, {
    id: createSafeId<"caseLawDecision">(),
    court: "Krajský soud v Brně",
    family,
  });
  await insertDecision(db, {
    id: createSafeId<"caseLawDecision">(),
    date: "2025-01-17",
    family,
  });
  await insertDecision(db, {
    id: createSafeId<"caseLawDecision">(),
    sheet: "36",
    family,
  });
  await apply({ db, id: REVIEWING, plan: planned });
  expect((await links(client)).at(0)).toHaveProperty(
    "reviewed_decision_id",
    null,
  );
  await insertDecision(db, { id: REVIEWED, family });
  await apply({ db, id: REVIEWED, plan: null });
  expect((await links(client)).at(0)).toHaveProperty(
    "reviewed_decision_id",
    REVIEWED,
  );
  const duplicate = createSafeId<"caseLawDecision">();
  await insertDecision(db, { id: duplicate, family });
  await apply({ db, id: duplicate, plan: null });
  expect((await links(client)).at(0)).toHaveProperty(
    "reviewed_decision_id",
    null,
  );
});

test("a refreshed opening removes stale edges while a metadata-only refresh preserves them", async () => {
  await using client = await prepare();
  const db = drizzle({ client });
  await insertDecision(db, { id: REVIEWING, court: "Nejvyšší správní soud" });
  await apply({ db, id: REVIEWING, plan: reviews() });
  await apply({ db, id: REVIEWING, plan: null });
  expect(await links(client)).toHaveLength(1);
  await apply({ db, id: REVIEWING, plan: [] });
  expect(await links(client)).toEqual([]);
  expect(
    await rejectionOf(
      client.exec(`INSERT INTO case_law_decision_reviews
    (reviewing_decision_id, reviewed_case_number, reviewed_citation_key,
      reviewed_docket_family_key, reviewed_court, outcome, source, evidence_classification, opening_evidence, parser_version)
    VALUES ('${REVIEWING}', '25 A 20/2024-35', 'key', 'key', 'court', 'not-an-outcome', 'opening', 'opening_only', '[]', 1)`),
    ),
  ).toMatchObject({ constraint: "case_law_decision_reviews_outcome_values" });
  expect(
    (
      await client.query(
        "SELECT has_column_privilege('stella_public_law_reader', 'case_law_decision_reviews', 'outcome', 'SELECT') AS allowed",
      )
    ).rows,
  ).toEqual([{ allowed: true }]);
});

test("moving a decision out of the Czech corpus clears its review projection", async () => {
  await using client = await prepare();
  const db = drizzle({ client });
  await insertDecision(db, { id: REVIEWING, court: "Nejvyšší správní soud" });
  await apply({ db, id: REVIEWING, plan: reviews() });
  expect(await links(client)).toHaveLength(1);
  await client.query(
    "UPDATE case_law_decisions SET country = 'SVK' WHERE id = $1",
    [REVIEWING],
  );
  await apply({
    db,
    id: REVIEWING,
    plan: null,
    country: "SVK",
    previousCountry: "CZE",
  });
  expect(await links(client)).toEqual([]);
  expect(
    (
      await client.query(
        "SELECT review_extraction_version FROM case_law_decisions WHERE id = $1",
        [REVIEWING],
      )
    ).rows,
  ).toEqual([{ review_extraction_version: null }]);
});

test("publisher metadata wins while conflicting opening targets remain inspectable", async () => {
  await using client = await prepare();
  const db = drizzle({ client });
  await insertDecision(db, { id: REVIEWING, court: "Nejvyšší správní soud" });
  const opening = reviews();
  const official = opening?.at(0);
  if (official === undefined) {
    throw new TypeError("The public opening fixture must extract a review");
  }
  const planned = planDecisionReviews({
    country: "CZE",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text: "V řízení o kasační stížnosti proti rozsudku Krajského soudu v Brně ze dne 17. 1. 2025, č. j. 25 A 21/2024-36, takto:",
      },
    ],
    metadata: {
      publisherReviews: [
        {
          reviewedCaseNumber: official.reviewedCaseNumber,
          reviewedCourt: official.reviewedCourt,
          reviewedDecisionDate: official.reviewedDecisionDate,
          outcome: official.outcome,
        },
      ],
    },
  });
  await apply({ db, id: REVIEWING, plan: planned });
  expect((await links(client)).at(0)).toMatchObject({
    reviewed_court: "Krajský soud v Ostravě",
    source: "metadata",
    evidence_classification: "conflict",
    opening_evidence: [
      expect.objectContaining({ reviewedCourt: "Krajský soud v Brně" }),
    ],
  });
});

test("reviewed judgments sharing a court and docket retain distinct dates and targets", async () => {
  await using client = await prepare();
  const db = drizzle({ client });
  const base = reviews()?.at(0);
  if (base === undefined) {
    throw new TypeError("The public opening fixture must extract a review");
  }
  const secondTarget = createSafeId<"caseLawDecision">();
  await insertDecision(db, { id: REVIEWING, court: "Nejvyšší správní soud" });
  await insertDecision(db, {
    id: REVIEWED,
    family: base.reviewedDocketFamilyKey,
  });
  await insertDecision(db, {
    id: secondTarget,
    date: "2025-01-17",
    family: base.reviewedDocketFamilyKey,
  });
  const planned = planDecisionReviews({
    country: "CZE",
    sections: [],
    metadata: {
      publisherReviews: ["2025-01-16", "2025-01-17"].map((date) => ({
        reviewedCaseNumber: base.reviewedCaseNumber,
        reviewedCourt: base.reviewedCourt,
        reviewedDecisionDate: date,
        outcome: base.outcome,
      })),
    },
  });
  await apply({ db, id: REVIEWING, plan: planned });
  expect(
    (
      await client.query(
        "SELECT reviewed_decision_date::text AS date, reviewed_decision_id AS target FROM case_law_decision_reviews ORDER BY reviewed_decision_date",
      )
    ).rows,
  ).toEqual([
    { date: "2025-01-16", target: REVIEWED },
    { date: "2025-01-17", target: secondTarget },
  ]);
  const first = planned?.at(0);
  if (first === undefined) {
    throw new TypeError("Publisher fixture must preserve its first target");
  }
  await apply({ db, id: REVIEWING, plan: [first] });
  expect(await links(client)).toHaveLength(1);
  expect((await links(client)).at(0)).toHaveProperty(
    "reviewed_decision_id",
    REVIEWED,
  );
});
