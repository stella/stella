import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { VerificationEvidenceFact } from "@/api/lib/lists/verification/contract";
import { contestedFactIdsOfClaim } from "@/api/lib/lists/verification/read-run";
import {
  contestedFactIds,
  EMPTY_CLAIM_REVIEW,
} from "@/api/lib/lists/verification/review-fold";
import type { ClaimReview } from "@/api/lib/lists/verification/review-fold";

const FACT = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
const LIST = toSafeId<"legalList">("33333333-3333-4333-8333-333333333333");

const fact = (interpretationNote: string | null): VerificationEvidenceFact => ({
  factEntityId: FACT,
  text: "Initialled by the director.",
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: null,
  interpretationNote,
  sources: [],
});

const pinned = { listId: LIST, facts: [fact("Initials may be a draft mark")] };
const inputs = { pinned, contested: contestedFactIds(pinned) };

const recheckedWith = (changed: VerificationEvidenceFact[]): ClaimReview => ({
  ...EMPTY_CLAIM_REVIEW,
  recheck: {
    grade: {
      state: "supported",
      score: 80,
      recordConflict: null,
      refs: [{ factEntityId: FACT, rel: "supports" }],
      qualifiers: [],
    },
    facts: { changed, removed: [] },
    modelRef: null,
    checkedAt: new Date(Date.UTC(2026, 10, 11, 10)),
    checkedBy: null,
  },
});

test("a claim never re-checked reads contested facts as the run pinned them", () => {
  expect([...contestedFactIdsOfClaim(inputs, EMPTY_CLAIM_REVIEW)]).toEqual([
    FACT,
  ]);
});

test("a re-checked claim reads contested facts as its re-check read them", () => {
  // The note was cleared before the re-check, so its grade rests on no
  // contested reading, whatever the run pinned.
  expect([
    ...contestedFactIdsOfClaim(inputs, recheckedWith([fact(null)])),
  ]).toEqual([]);
  // Unchanged since the run, the pinned reading still holds for it.
  expect([...contestedFactIdsOfClaim(inputs, recheckedWith([]))]).toEqual([
    FACT,
  ]);
});
