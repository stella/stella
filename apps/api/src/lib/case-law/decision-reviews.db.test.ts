import { panic } from "better-result";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import {
  DECISION_REVIEW_LINK_LIMIT,
  decisionReviewsSchema,
} from "@stll/api-contract/case-law-reviews";

import {
  caseLawDecisionReviews,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  decisionReviewStatus,
  readDecisionReviewsWithin,
  requireDecisionReviews,
} from "@/api/lib/case-law/decision-reviews";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

test("public appeal evidence is bounded, publication gated and independent of unrelated corpus growth", async () => {
  await using client = await createTestPglite();
  let statements = 0;
  const db = drizzle({
    client,
    logger: {
      logQuery: () => {
        statements += 1;
      },
    },
  });
  const sourceId = createSafeId<"caseLawSource">();
  const closedSourceId = createSafeId<"caseLawSource">();
  const lowerId = createSafeId<"caseLawDecision">();
  const emptyId = createSafeId<"caseLawDecision">();
  const hiddenId = createSafeId<"caseLawDecision">();
  const crossCountryId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawSources).values([
    caseLawSourceRow({ id: sourceId, adapterKey: "appeal-public" }),
    caseLawSourceRow({
      id: closedSourceId,
      adapterKey: "appeal-closed",
      descriptor: {
        allowsRedistribution: false,
        allowsDerivedAi: false,
        attribution: null,
        license: "restricted",
      },
    }),
  ]);
  const decision = (
    id: typeof lowerId,
    selectedSourceId = sourceId,
    country = "CZE",
  ) => ({
    id,
    sourceId: selectedSourceId,
    country,
    court: "Nejvyšší správní soud",
    caseNumber: `7 As 32/2025-${id}`,
    language: "cs",
  });
  const reviewers = Array.from({ length: DECISION_REVIEW_LINK_LIMIT + 1 }, () =>
    createSafeId<"caseLawDecision">(),
  );
  await db
    .insert(caseLawDecisions)
    .values([
      decision(lowerId),
      decision(emptyId),
      decision(hiddenId, closedSourceId),
      decision(crossCountryId, sourceId, "SVK"),
      ...reviewers.map((id) => decision(id)),
    ]);
  await db.insert(caseLawDecisionReviews).values(
    [...reviewers, hiddenId, crossCountryId].map(
      (reviewingDecisionId) =>
        ({
          reviewingDecisionId,
          reviewedDecisionId: lowerId,
          reviewedCaseNumber: "25 A 20/2024-35",
          reviewedCitationKey: "25a20/2024",
          reviewedDocketFamilyKey: "25a20/2024",
          reviewedCourt: "Krajský soud v Ostravě",
          reviewedDecisionDate: "2025-01-16",
          outcome: "upheld",
          source: "opening",
          evidenceStatus: "opening_only",
          openingEvidence: [],
          parserVersion: 1,
        }) satisfies typeof caseLawDecisionReviews.$inferInsert,
    ),
  );
  const read = async () =>
    await withPublicLawReaderRole(db, async (tx) => {
      const before = statements;
      const map = await readDecisionReviewsWithin({
        decisionIds: [lowerId, emptyId, hiddenId],
        countries: ["CZE"],
        tx,
      });
      expect(statements - before).toBe(2);
      return map;
    });
  const before = await read();
  const evidence = requireDecisionReviews(before, lowerId);
  expect(v.safeParse(decisionReviewsSchema, evidence).success).toBe(true);
  expect(evidence.status).toBe("unknown");
  expect(evidence.reviewedByTruncated).toBe(true);
  expect(evidence.reviewedBy.length).toBeGreaterThan(0);
  expect(evidence.reviewedBy.length).toBeLessThanOrEqual(
    DECISION_REVIEW_LINK_LIMIT,
  );
  expect(
    evidence.reviewedBy.every(({ reviewingDecisionId }) =>
      reviewers.some((id) => id === reviewingDecisionId),
    ),
  ).toBe(true);
  expect(requireDecisionReviews(before, emptyId)).toMatchObject({
    status: "none_found",
    basis: "available_corpus",
    reason: "no_link_in_corpus",
  });
  expect(requireDecisionReviews(before, hiddenId).reviews).toEqual([]);
  await db
    .insert(caseLawDecisions)
    .values(
      Array.from({ length: 200 }, () =>
        decision(createSafeId<"caseLawDecision">()),
      ),
    );
  expect(await read()).toEqual(before);
  expect(decisionReviewStatus(evidence.reviewedBy)).toBe("upheld");
  const first =
    evidence.reviewedBy.at(0) ?? panic("Review fixture has no evidence");
  expect(
    decisionReviewStatus([
      ...evidence.reviewedBy,
      { ...first, outcome: "overturned" },
    ]),
  ).toBe("unknown");
  expect(decisionReviewStatus([{ ...first, evidenceStatus: "conflict" }])).toBe(
    "unknown",
  );
  expect(decisionReviewStatus([{ ...first, outcome: "pending" }])).toBe(
    "under_review",
  );
  const cappedId = createSafeId<"caseLawDecision">();
  const hiddenReviewers = Array.from(
    { length: DECISION_REVIEW_LINK_LIMIT + 1 },
    (_, index) =>
      toSafeId<"caseLawDecision">(
        `00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
      ),
  );
  await db
    .insert(caseLawDecisions)
    .values([
      decision(cappedId),
      ...hiddenReviewers.map((id) => decision(id, closedSourceId)),
    ]);
  await db.insert(caseLawDecisionReviews).values(
    [...hiddenReviewers, first.reviewingDecisionId].map(
      (reviewingDecisionId) =>
        ({
          reviewingDecisionId: toSafeId<"caseLawDecision">(reviewingDecisionId),
          reviewedDecisionId: cappedId,
          reviewedCaseNumber: "25 A 20/2024-35",
          reviewedCitationKey: "25a20/2024",
          reviewedDocketFamilyKey: "25a20/2024",
          reviewedCourt: "Krajský soud v Ostravě",
          outcome: "upheld",
          source: "opening",
          evidenceStatus: "opening_only",
          openingEvidence: [],
          parserVersion: 1,
        }) satisfies typeof caseLawDecisionReviews.$inferInsert,
    ),
  );
  const capped = await withPublicLawReaderRole(db, async (tx) =>
    requireDecisionReviews(
      await readDecisionReviewsWithin({ decisionIds: [cappedId], tx }),
      cappedId,
    ),
  );
  expect(capped).toMatchObject({
    status: "unknown",
    reviewedBy: [],
    reviewedByTruncated: true,
  });
});
