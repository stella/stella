import { expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";

import { toSafeId, type SafeId } from "@/api/lib/branded-types";

import {
  CORPUS_PROJECTION_GENERATION_SCOPE,
  CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT,
  entityIdsForCorpusProjectionWorkScope,
  type CorpusProjectionScopedWorkOptions,
} from "./corpus-index-projection-scope";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000202",
);
const SCOPE_ERROR = `must contain 1 to ${CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT} unique entities`;
const distinctDecisionIds = Array.from(
  { length: CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT + 1 },
  (_, index) =>
    toSafeId<"caseLawDecision">(
      `0198e331-e578-7000-8000-${index.toString(16).padStart(12, "0")}`,
    ),
);

type MismatchedCaseLawScope = {
  family: "case_law";
  scope: {
    type: "subjects";
    entityIds: readonly SafeId<"legislationDocument">[];
  };
};

test("a subject scope couples entity identities to its family", () => {
  expectTypeOf<MismatchedCaseLawScope>().not.toExtend<
    CorpusProjectionScopedWorkOptions<"case_law">
  >();
});

test("a generation scope has no entity predicate", () => {
  expect(
    entityIdsForCorpusProjectionWorkScope(CORPUS_PROJECTION_GENERATION_SCOPE),
  ).toBeNull();
});

test("a subject scope preserves its exact identities", () => {
  expect(
    entityIdsForCorpusProjectionWorkScope({
      type: "subjects",
      entityIds: [DECISION_ID],
    }),
  ).toEqual([DECISION_ID]);
});

test("a subject scope rejects empty, duplicate, and oversized sets", () => {
  expect(() =>
    entityIdsForCorpusProjectionWorkScope({
      type: "subjects",
      entityIds: [],
    }),
  ).toThrow(SCOPE_ERROR);
  expect(() =>
    entityIdsForCorpusProjectionWorkScope({
      type: "subjects",
      entityIds: [DECISION_ID, DECISION_ID],
    }),
  ).toThrow(SCOPE_ERROR);
  expect(() =>
    entityIdsForCorpusProjectionWorkScope({
      type: "subjects",
      entityIds: distinctDecisionIds,
    }),
  ).toThrow(SCOPE_ERROR);
  expect(
    entityIdsForCorpusProjectionWorkScope({
      type: "subjects",
      entityIds: distinctDecisionIds.slice(
        0,
        CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT,
      ),
    }),
  ).toHaveLength(CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT);
});
