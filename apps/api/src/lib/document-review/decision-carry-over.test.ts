/**
 * Which decisions a re-run inherits. The rule under test is Ironclad's:
 * unchanged content keeps the reading a lawyer already gave it, changed
 * content goes back to the queue.
 */

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  matchCarriedDecisions,
  planCarriedDecisions,
} from "@/api/lib/document-review/decision-carry-over";
import type { CarryOverFinding } from "@/api/lib/document-review/decision-carry-over";
import type { DocumentReviewFindingPayload } from "@/api/lib/document-review/run-contract";
import type {
  Position,
  PositionTermKind,
} from "@/api/lib/workflow/playbook-positions";
import type { TierStandardPosition } from "@/api/lib/workflow/position-runtime";

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

const RULE_ID = "66666666-6666-4666-8666-666666666666";

const tierPosition = (
  sourceId: string = POSITION_ID,
): TierStandardPosition => ({
  mode: "graded",
  sourceId,
  issue: "Governing law",
  severity: "high",
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: [{ id: RULE_ID, text: "English law governs" }],
      },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ask: { mode: "auto" },
  enabled: true,
});

const referencePosition = (termKind: PositionTermKind = "parameter") =>
  ({
    mode: "graded",
    sourceId: POSITION_ID,
    issue: "Governing law",
    severity: "high",
    standard: {
      source: "reference",
      termKind,
      passages: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          workspaceId: "77777777-7777-4777-8777-777777777777",
          entityId: "88888888-8888-4888-8888-888888888888",
          fileFieldId: "22222222-2222-4222-8222-222222222222",
          entityVersionId: "99999999-9999-4999-8999-999999999999",
          blockId: "para-9",
        },
      ],
    },
    ask: { mode: "auto" },
    enabled: true,
  }) as const satisfies Position;

const extractPosition = () =>
  ({
    mode: "extract",
    sourceId: POSITION_ID,
    issue: "Governing law",
    ask: {
      question: "Which law governs?",
      content: { version: 1, type: "text" },
    },
    enabled: true,
  }) as const satisfies Position;

const POSITIONS = [
  tierPosition(),
  tierPosition(OTHER_POSITION_ID),
] as const satisfies readonly Position[];

/** Matching against unchanged rules, unless a test says otherwise. */
const match = ({
  current,
  prior,
  currentPositions = POSITIONS,
  priorPositions = POSITIONS,
}: {
  current: readonly CarryOverFinding[];
  prior: readonly CarryOverFinding[];
  currentPositions?: readonly Position[];
  priorPositions?: readonly Position[];
}) =>
  matchCarriedDecisions({ current, prior, currentPositions, priorPositions });

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

    expect(match({ current: [current], prior: [prior] })).toEqual([
      { findingId: current.id, priorFindingId: prior.id },
    ]);
  });

  test("resets when the outcome changed", () => {
    const prior = finding({ decision: "dismissed" });
    const current = finding({ outcome: "deviation" });

    expect(match({ current: [current], prior: [prior] })).toEqual([]);
  });

  test("resets when the cited evidence changed", () => {
    const prior = finding({ decision: "accepted" });
    const current = finding({
      payload: payload("This Agreement is governed by Delaware law"),
    });

    expect(match({ current: [current], prior: [prior] })).toEqual([]);
  });

  test("does not carry across positions", () => {
    const priorOtherPosition = finding({
      decision: "accepted",
      positionId: OTHER_POSITION_ID,
    });
    const current = finding();

    expect(
      match({
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

    expect(match({ current: [current], prior: [prior] })).toEqual([]);
  });

  test("carries nothing from a prior finding nobody answered", () => {
    expect(match({ current: [finding()], prior: [finding()] })).toEqual([]);
  });

  // Flagging a finding is work a re-run must not erase, even when the reviewer
  // has not yet decided it.
  test("carries flags from a prior finding left open", () => {
    const prior = finding({ flags: ["follow-up"] });
    const current = finding();

    expect(match({ current: [current], prior: [prior] })).toEqual([
      { findingId: current.id, priorFindingId: prior.id },
    ]);
  });

  test("resets flags when the cited evidence changed", () => {
    const prior = finding({ flags: ["contradiction"] });
    const current = finding({
      payload: payload("This Agreement is governed by Delaware law"),
    });

    expect(match({ current: [current], prior: [prior] })).toEqual([]);
  });

  test("never overwrites flags already on the new finding", () => {
    const prior = finding({ decision: "accepted", flags: ["important"] });
    const current = finding({ flags: ["needs-review"] });

    expect(match({ current: [current], prior: [prior] })).toEqual([]);
  });

  // A replayed completion must not reset a decision taken since the run
  // finished, so an already-decided finding is never a carry-over target.
  test("never overwrites a decision already on the new finding", () => {
    const prior = finding({ decision: "dismissed" });
    const current = finding({ decision: "accepted" });

    expect(match({ current: [current], prior: [prior] })).toEqual([]);
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
      match({
        current: [carried, changed],
        prior: [priorCarried, priorChanged],
      }),
    ).toEqual([{ findingId: carried.id, priorFindingId: priorCarried.id }]);
  });
});

describe("matchCarriedDecisions when the position's rules moved", () => {
  const prior = finding({ decision: "accepted" });
  const current = finding();
  const carried = [{ findingId: current.id, priorFindingId: prior.id }];
  const base = tierPosition();
  const { tiers } = base.standard;

  const withTiers = (changed: Partial<typeof tiers>): Position => ({
    ...base,
    standard: { source: "tiers", tiers: { ...tiers, ...changed } },
  });
  const carriedAcross = (priorPosition: Position, currentPosition: Position) =>
    match({
      current: [current],
      prior: [prior],
      currentPositions: [currentPosition],
      priorPositions: [priorPosition],
    });

  test("keeps the decision when the rules are unchanged", () => {
    expect(carriedAcross(base, tierPosition())).toEqual(carried);
  });

  test.each<[string, Position]>([
    ["the issue", { ...base, issue: "Choice of law" }],
    [
      "an acceptable rule",
      withTiers({
        acceptable: { rules: [{ id: RULE_ID, text: "Scots law governs" }] },
      }),
    ],
    [
      "a fallback",
      withTiers({
        fallback: { entries: [{ id: RULE_ID, text: "Irish law governs" }] },
      }),
    ],
    [
      "a red line",
      withTiers({
        notAcceptable: { rules: [{ id: RULE_ID, text: "Any US state law" }] },
      }),
    ],
    [
      "the deterministic check",
      { ...base, check: { kind: "presence", expectation: "required" } },
    ],
  ])("reopens the finding when %s changed", (_label, changed) => {
    expect(carriedAcross(base, changed)).toEqual([]);
  });

  test("keeps the decision when only ideal language changed", () => {
    const edited = withTiers({
      acceptable: {
        rules: tiers.acceptable.rules,
        ideal: { source: "inline", text: "This Agreement is governed by..." },
      },
    });

    expect(edited).not.toEqual(base);
    expect(carriedAcross(base, edited)).toEqual(carried);
  });

  test("keeps the decision on a reference position whose kind is unchanged", () => {
    expect(
      carriedAcross(
        referencePosition("parameter"),
        referencePosition("presence"),
      ),
    ).toEqual(carried);
  });

  test("keeps the decision on an extract position", () => {
    expect(carriedAcross(extractPosition(), extractPosition())).toEqual(
      carried,
    );
  });

  test.each<[string, Position, Position]>([
    ["tiers to a reference", tierPosition(), referencePosition()],
    ["a reference to tiers", referencePosition(), tierPosition()],
    ["extract to graded", extractPosition(), tierPosition()],
    ["a reference to extract", referencePosition(), extractPosition()],
  ])("does not match when the kind changed from %s", (_label, from, to) => {
    expect(carriedAcross(from, to)).toEqual([]);
  });

  test("does not carry when a run's pin does not list the position", () => {
    expect(carriedAcross(tierPosition(OTHER_POSITION_ID), base)).toEqual([]);
    expect(carriedAcross(base, tierPosition(OTHER_POSITION_ID))).toEqual([]);
  });
});

describe("planCarriedDecisions outcomes", () => {
  const plan = (current: CarryOverFinding[], prior: CarryOverFinding[]) =>
    planCarriedDecisions({
      current,
      prior,
      currentPositions: POSITIONS,
      priorPositions: POSITIONS,
    });

  test("names what became of every answered prior finding, and only those", () => {
    const carried = finding({ decision: "accepted" });
    const reworded = finding({
      decision: "accepted",
      positionId: OTHER_POSITION_ID,
    });
    const unanswered = finding({
      positionId: "00000000-0000-4000-8000-000000000000",
    });
    const { outcomes } = plan(
      [
        finding(),
        finding({
          positionId: OTHER_POSITION_ID,
          payload: payload("This Agreement is governed by Scots law"),
        }),
      ],
      [carried, reworded, unanswered],
    );
    expect(outcomes).toEqual(
      new Map([
        [carried.id, "carried"],
        [reworded.id, "text-changed"],
      ]),
    );
  });

  test("another conclusion is a changed verdict, a missing answer is unmatched", () => {
    const regraded = finding({ decision: "accepted" });
    const dropped = finding({
      decision: "rejected",
      positionId: OTHER_POSITION_ID,
    });
    const { carried, outcomes } = plan(
      [finding({ outcome: "non-compliant" })],
      [regraded, dropped],
    );
    expect(carried).toEqual([]);
    expect(outcomes).toEqual(
      new Map([
        [regraded.id, "verdict-changed"],
        [dropped.id, "unmatched"],
      ]),
    );
  });
});
