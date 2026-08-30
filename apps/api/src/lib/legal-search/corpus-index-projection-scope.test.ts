import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  CORPUS_PROJECTION_GENERATION_SCOPE,
  CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT,
  entityIdsForCorpusProjectionWorkScope,
} from "./corpus-index-projection-scope";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000202",
);
const SCOPE_ERROR =
  `must contain 1 to ${CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT} unique entities`;

test("a generation scope has no entity predicate", () => {
  expect(
    entityIdsForCorpusProjectionWorkScope(
      CORPUS_PROJECTION_GENERATION_SCOPE,
    ),
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
      entityIds: Array.from(
        { length: CORPUS_PROJECTION_WORK_SCOPE_MAX_ENTITY_COUNT + 1 },
        () => DECISION_ID,
      ),
    }),
  ).toThrow(SCOPE_ERROR);
});
