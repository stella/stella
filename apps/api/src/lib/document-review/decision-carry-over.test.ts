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

const POSITION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_POSITION_ID = "55555555-5555-4555-8555-555555555555";

const findingId = (): SafeId<"documentReviewFinding"> =>
  toSafeId<"documentReviewFinding">(Bun.randomUUIDv7());

const payload = (excerpt: string): DocumentReviewFindingPayload => ({
  finding: {
    positionId: POSITION_ID,
    issue: "Governing law",
    severity: "high",
    standardSource: "tiers",
    verdict: "compliant",
    delta: { kind: "language" },
    extracted: { value: "England and Wales", text: excerpt },
    rationale: "Matches the standard.",
    citations: [{ blockId: "para-7", text: excerpt }],
    fix: null,
  },
});

const referencePayload = (excerpt: string): DocumentReviewFindingPayload => ({
  finding: {
    positionId: POSITION_ID,
    issue: "Governing law",
    severity: "high",
    standardSource: "reference",
    verdict: "compliant",
    delta: { kind: "language" },
    extracted: null,
    consensus: "single",
    rationale: "Both pick the same forum.",
    explanation: { type: "comparison", text: "Both pick the same forum." },
    citations: [{ blockId: "para-7", text: excerpt }],
    referenceCitations: [
      {
        fileFieldId: toSafeId<"field">("22222222-2222-4222-8222-222222222222"),
        passages: [
          { id: "33333333-3333-4333-8333-333333333333", blockId: "para-9" },
        ],
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
  positionId: POSITION_ID,
  outcome: "compliant",
  payload: payload(EXCERPT),
  decision: "open",
  flags: [],
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

  test("does not carry across positions", () => {
    const priorOtherPosition = finding({
      decision: "accepted",
      positionId: OTHER_POSITION_ID,
    });
    const current = finding();

    expect(
      matchCarriedDecisions({
        current: [current],
        prior: [priorOtherPosition],
      }),
    ).toEqual([]);
  });

  // A reference comparison quotes the standard's own passages, so it rests on
  // evidence a tier match never had. Same verdict, different evidence: the
  // reviewer has to look again.
  test("resets when the evidence behind the same verdict changed", () => {
    const prior = finding({ decision: "accepted" });
    const current = finding({ payload: referencePayload(EXCERPT) });

    expect(
      matchCarriedDecisions({ current: [current], prior: [prior] }),
    ).toEqual([]);
  });

  test("carries nothing from a prior finding nobody answered", () => {
    expect(
      matchCarriedDecisions({ current: [finding()], prior: [finding()] }),
    ).toEqual([]);
  });

  // Flagging a finding is work a re-run must not erase, even when the reviewer
  // has not yet decided it.
  test("carries flags from a prior finding left open", () => {
    const prior = finding({ flags: ["follow-up"] });
    const current = finding();

    expect(
      matchCarriedDecisions({ current: [current], prior: [prior] }),
    ).toEqual([{ findingId: current.id, priorFindingId: prior.id }]);
  });

  test("resets flags when the cited evidence changed", () => {
    const prior = finding({ flags: ["contradiction"] });
    const current = finding({
      payload: payload("This Agreement is governed by Delaware law"),
    });

    expect(
      matchCarriedDecisions({ current: [current], prior: [prior] }),
    ).toEqual([]);
  });

  test("never overwrites flags already on the new finding", () => {
    const prior = finding({ decision: "accepted", flags: ["important"] });
    const current = finding({ flags: ["needs-review"] });

    expect(
      matchCarriedDecisions({ current: [current], prior: [prior] }),
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
      positionId: OTHER_POSITION_ID,
    });
    const carried = finding();
    const changed = finding({
      positionId: OTHER_POSITION_ID,
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
