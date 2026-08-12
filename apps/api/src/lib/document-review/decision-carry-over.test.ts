/**
 * Which decisions a re-run inherits. The rule under test is Ironclad's:
 * unchanged content keeps the reading a lawyer already gave it, changed
 * content goes back to the queue.
 */

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { matchCarriedDecisions } from "@/api/lib/document-review/decision-carry-over";
import type { CarryOverFinding } from "@/api/lib/document-review/decision-carry-over";
import type { DocumentReviewFindingPayload } from "@/api/lib/document-review/run-contract";

const TOPIC_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_TOPIC_ID = "55555555-5555-4555-8555-555555555555";
const POSITION_ID = "11111111-1111-4111-8111-111111111111";

const findingId = (): SafeId<"documentReviewFinding"> =>
  toSafeId<"documentReviewFinding">(Bun.randomUUIDv7());

type PlaybookPayload = Extract<
  DocumentReviewFindingPayload,
  { checkKind: "playbook" }
>;

const payload = (excerpt: string): PlaybookPayload => ({
  checkKind: "playbook",
  finding: {
    positionId: POSITION_ID,
    issue: "Governing law",
    severity: "high",
    verdict: "compliant",
    extracted: { value: "England and Wales", text: excerpt },
    rationale: "Matches the standard.",
    citations: [{ blockId: "para-7", text: excerpt }],
    fix: null,
  },
});

type ReferencePayload = Extract<
  DocumentReviewFindingPayload,
  { checkKind: "reference" }
>;

const referencePayload = (excerpt: string): ReferencePayload => ({
  checkKind: "reference",
  finding: {
    findingId: `reference-${TOPIC_ID}`,
    topicId: TOPIC_ID,
    issue: "Governing law",
    assessment: "aligned",
    consensus: "single",
    explanation: { type: "comparison", text: "Both pick the same forum." },
    targetCitations: [{ blockId: "para-7", text: excerpt }],
    referenceCitations: [
      {
        fileFieldId: toSafeId<"field">("22222222-2222-4222-8222-222222222222"),
        citations: [{ blockId: "para-9", text: excerpt }],
      },
    ],
    fix: null,
  },
});

const EXCERPT = "This Agreement is governed by English law";

const finding = (
  overrides: Partial<CarryOverFinding> = {},
): CarryOverFinding => ({
  id: findingId(),
  topicId: TOPIC_ID,
  checkKind: "playbook",
  outcome: "compliant",
  payload: payload(EXCERPT),
  decision: "open",
  ...overrides,
});

describe("matchCarriedDecisions", () => {
  test("carries a decision onto an identical finding", () => {
    const prior = finding({ decision: "accepted" });
    const current = finding();

    expect(
      matchCarriedDecisions({ current: [current], prior: [prior] }),
    ).toEqual([{ findingId: current.id, priorFindingId: prior.id }]);
  });

  test("resets when the outcome changed", () => {
    const prior = finding({ decision: "dismissed" });
    const current = finding({ outcome: "deviation" });

    expect(
      matchCarriedDecisions({ current: [current], prior: [prior] }),
    ).toEqual([]);
  });

  test("resets when the cited evidence changed", () => {
    const prior = finding({ decision: "accepted" });
    const current = finding({
      payload: payload("This Agreement is governed by Delaware law"),
    });

    expect(
      matchCarriedDecisions({ current: [current], prior: [prior] }),
    ).toEqual([]);
  });

  test("does not carry across topics or check kinds", () => {
    const priorOtherTopic = finding({
      decision: "accepted",
      topicId: OTHER_TOPIC_ID,
    });
    const priorOtherKind = finding({
      decision: "accepted",
      checkKind: "reference",
      outcome: "aligned",
      payload: referencePayload(EXCERPT),
    });
    const current = finding();

    expect(
      matchCarriedDecisions({
        current: [current],
        prior: [priorOtherTopic, priorOtherKind],
      }),
    ).toEqual([]);
  });

  test("carries nothing from an undecided prior finding", () => {
    expect(
      matchCarriedDecisions({ current: [finding()], prior: [finding()] }),
    ).toEqual([]);
  });

  // A replayed completion must not reset a decision taken since the run
  // finished, so an already-decided finding is never a carry-over target.
  test("never overwrites a decision already on the new finding", () => {
    const prior = finding({ decision: "dismissed" });
    const current = finding({ decision: "accepted" });

    expect(
      matchCarriedDecisions({ current: [current], prior: [prior] }),
    ).toEqual([]);
  });

  test("matches each finding independently within one run", () => {
    const priorCarried = finding({ decision: "accepted" });
    const priorChanged = finding({
      decision: "accepted",
      topicId: OTHER_TOPIC_ID,
    });
    const carried = finding();
    const changed = finding({
      topicId: OTHER_TOPIC_ID,
      payload: payload("An entirely different passage"),
    });

    expect(
      matchCarriedDecisions({
        current: [carried, changed],
        prior: [priorCarried, priorChanged],
      }),
    ).toEqual([{ findingId: carried.id, priorFindingId: priorCarried.id }]);
  });
});
