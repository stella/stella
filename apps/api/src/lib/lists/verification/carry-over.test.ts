import { describe, expect, test } from "bun:test";

import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  planClaimCarry,
  sameReviewedVerdict,
} from "@/api/lib/lists/verification/carry-over";
import type {
  CarriedSourceEvent,
  CarryDecision,
} from "@/api/lib/lists/verification/carry-over";
import type {
  ClaimReviewEventKind,
  RecordConflict,
  StoredClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";
import {
  CLAIM_REVIEW_CARRY_RULE,
  CLAIM_REVIEW_EVENT_KINDS,
} from "@/api/lib/lists/verification/contract";
import { foldClaimReview } from "@/api/lib/lists/verification/review-fold";
import type { CarryOutcome } from "@/api/lib/review/carry-outcomes";

const FACT_A = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
const FACT_B = toSafeId<"entity">("22222222-2222-4222-8222-222222222222");
const FACT_C = toSafeId<"entity">("33333333-3333-4333-8333-333333333333");

const conflict = (
  factEntityIds: RecordConflict["factEntityIds"],
): RecordConflict => ({
  subject: "Date of the transfer",
  factEntityIds,
  values: ["9 March", "3 May"],
  governingStates: ["contradicted", "supported"],
});

const SUPPORTED = { state: "supported", recordConflict: null } as const;
const CONTRADICTED = { state: "contradicted", recordConflict: null } as const;
const NOT_VERIFIABLE = {
  state: "notverifiable",
  recordConflict: null,
} as const;
const CONFLICT_AB = {
  state: "recordconflict",
  recordConflict: conflict([FACT_A, FACT_B]),
} as const;

let clock = Date.UTC(2026, 10, 9, 9);
const event = (payload: StoredClaimReviewEventPayload): CarriedSourceEvent => {
  clock += 1000;
  return {
    id: createSafeId<"legalListClaimReviewEvent">(),
    payload,
    actorId: "user_reviewer",
    createdAt: new Date(clock),
  };
};

const recheckTo = (state: "supported" | "contradicted") =>
  event({
    kind: "recheck",
    requestKey: `key-${String(clock)}`,
    grade: {
      state,
      score: state === "supported" ? 85 : 15,
      recordConflict: null,
      refs: [],
      qualifiers: [],
    },
    facts: { changed: [], removed: [] },
    modelRef: null,
  });

/** One action of each kind, on a claim whose verdict suits it. */
const EXAMPLES = {
  status: {
    claim: SUPPORTED,
    changed: CONTRADICTED,
    events: () => [
      event({ kind: "status", status: "reviewed", origin: "single" }),
    ],
  },
  override: {
    claim: SUPPORTED,
    changed: CONTRADICTED,
    events: () => [
      event({ kind: "override", state: "tension", reason: "Hedged." }),
    ],
  },
  note: {
    claim: SUPPORTED,
    changed: CONTRADICTED,
    events: () => [event({ kind: "note", note: "Ask for the diary." })],
  },
  reopen: {
    claim: NOT_VERIFIABLE,
    changed: SUPPORTED,
    events: () => [event({ kind: "reopen", reason: "The date is checkable." })],
  },
  "record-conflict": {
    claim: CONFLICT_AB,
    changed: { ...CONFLICT_AB, recordConflict: conflict([FACT_A, FACT_C]) },
    events: () => [
      event({
        kind: "record-conflict",
        resolution: { kind: "governed", factEntityId: FACT_A },
        reason: "The bank record governs.",
      }),
    ],
  },
  "fact-link": {
    claim: SUPPORTED,
    changed: CONTRADICTED,
    events: () => [
      event({ kind: "fact-link", factEntityId: FACT_B, change: "link" }),
    ],
  },
  recheck: {
    claim: SUPPORTED,
    changed: CONTRADICTED,
    events: () => [recheckTo("supported")],
  },
} as const satisfies Record<
  ClaimReviewEventKind,
  {
    claim: Parameters<typeof planClaimCarry>[0]["source"];
    changed: Parameters<typeof planClaimCarry>[0]["target"];
    events: () => CarriedSourceEvent[];
  }
>;

/** What each carry rule does to an action on the same claim, on a changed
 *  verdict, and on edited words. */
const EXPECTED = {
  always: { same: "carried", changed: "carried", edited: "carried" },
  "unchanged-claim": {
    same: "carried",
    changed: "verdict-changed",
    edited: "words-changed",
  },
  never: { same: "fresh-grade", changed: "fresh-grade", edited: "fresh-grade" },
} as const satisfies Record<
  (typeof CLAIM_REVIEW_CARRY_RULE)[ClaimReviewEventKind],
  { same: CarryDecision; changed: CarryDecision; edited: CarryDecision }
>;

/** The outcome a claim's single decision gives it. */
const OUTCOME_OF = {
  carried: "carried",
  "verdict-changed": "verdict-changed",
  "words-changed": "text-changed",
  "fresh-grade": null,
  redundant: "carried",
} as const satisfies Record<CarryDecision, CarryOutcome | null>;

const decisionsOf = (plan: ReturnType<typeof planClaimCarry>) =>
  plan?.decisions.map(({ decision }) => decision) ?? null;

describe("which review actions follow a claim to the next run", () => {
  test("every action kind is judged by the carry map, on the same claim, a changed verdict and edited words", () => {
    const exercised: ClaimReviewEventKind[] = [];
    for (const kind of CLAIM_REVIEW_EVENT_KINDS) {
      const example = EXAMPLES[kind];
      const expected = EXPECTED[CLAIM_REVIEW_CARRY_RULE[kind]];
      // The changed verdict is one the rule can tell apart.
      expect(sameReviewedVerdict(example.claim, example.changed)).toBe(false);
      const events = example.events();
      const plans = {
        same: planClaimCarry({
          source: example.claim,
          events,
          target: example.claim,
          wording: "same",
        }),
        changed: planClaimCarry({
          source: example.claim,
          events,
          target: example.changed,
          wording: "same",
        }),
        edited: planClaimCarry({
          source: example.claim,
          events,
          target: example.claim,
          wording: "edited",
        }),
      };
      for (const variant of ["same", "changed", "edited"] as const) {
        const plan = plans[variant];
        if (CLAIM_REVIEW_CARRY_RULE[kind] === "never") {
          // Nothing on the claim could follow, so it is not recorded at all.
          expect(plan).toBeNull();
        } else {
          const decision: CarryDecision = expected[variant];
          expect(decisionsOf(plan)).toEqual([decision]);
          expect<CarryOutcome | null | undefined>(plan?.outcome).toBe(
            OUTCOME_OF[decision],
          );
        }
      }
      exercised.push(kind);
    }
    // Declared and exercised kinds agree in both directions.
    expect<string[]>(exercised.toSorted()).toEqual(
      Object.keys(CLAIM_REVIEW_CARRY_RULE).toSorted(),
    );
  });

  test("an action after a re-check is judged on the re-check's verdict", () => {
    const reviewed = event({
      kind: "status",
      status: "reviewed",
      origin: "single",
    });
    const recheck = recheckTo("contradicted");
    const disputed = event({
      kind: "status",
      status: "disputed",
      origin: "single",
      reason: "The bank record is dated later.",
    });
    const note = event({ kind: "note", note: "Ask for the statement." });
    const plan = planClaimCarry({
      source: SUPPORTED,
      events: [reviewed, recheck, disputed, note],
      target: CONTRADICTED,
      wording: "same",
    });
    expect(plan?.decisions).toEqual([
      { eventId: reviewed.id, decision: "verdict-changed" },
      { eventId: recheck.id, decision: "fresh-grade" },
      { eventId: disputed.id, decision: "carried" },
      { eventId: note.id, decision: "carried" },
    ]);
    expect(plan?.outcome).toBe("verdict-changed");
    const review = foldClaimReview(plan?.events ?? []);
    expect(review.status).toBe("disputed");
    expect(review.note).toBe("Ask for the statement.");
  });

  test("a record conflict's resolution follows only between the same two records", () => {
    const governed = event({
      kind: "record-conflict",
      resolution: { kind: "governed", factEntityId: FACT_B },
      reason: "The minutes govern.",
    });
    const swapped = {
      ...CONFLICT_AB,
      recordConflict: conflict([FACT_B, FACT_A]),
    };
    expect(
      decisionsOf(
        planClaimCarry({
          source: CONFLICT_AB,
          events: [governed],
          target: swapped,
          wording: "same",
        }),
      ),
    ).toEqual(["carried"]);
    expect(
      decisionsOf(
        planClaimCarry({
          source: CONFLICT_AB,
          events: [governed],
          target: {
            ...CONFLICT_AB,
            recordConflict: conflict([FACT_B, FACT_C]),
          },
          wording: "same",
        }),
      ),
    ).toEqual(["verdict-changed"]);
  });

  test("a reopening already carried is not written twice", () => {
    const first = event({ kind: "reopen", reason: "The date is checkable." });
    const recheck = event({
      kind: "recheck",
      requestKey: "set-aside-again",
      grade: {
        state: "notverifiable",
        score: null,
        recordConflict: null,
        refs: [],
        qualifiers: [],
      },
      facts: { changed: [], removed: [] },
      modelRef: null,
    });
    const second = event({ kind: "reopen", reason: "Still checkable." });
    const plan = planClaimCarry({
      source: NOT_VERIFIABLE,
      events: [first, recheck, second],
      target: NOT_VERIFIABLE,
      wording: "same",
    });
    expect(decisionsOf(plan)).toEqual(["carried", "fresh-grade", "redundant"]);
    expect(plan?.events).toEqual([first]);
    expect(plan?.outcome).toBe("carried");
  });

  test("edited words keep the notes and links, never the decisions", () => {
    const reviewed = event({
      kind: "status",
      status: "reviewed",
      origin: "single",
    });
    const note = event({ kind: "note", note: "Matches the bank statement." });
    const link = event({
      kind: "fact-link",
      factEntityId: FACT_A,
      change: "link",
    });
    const plan = planClaimCarry({
      source: SUPPORTED,
      events: [reviewed, note, link],
      target: SUPPORTED,
      wording: "edited",
    });
    expect(decisionsOf(plan)).toEqual(["words-changed", "carried", "carried"]);
    expect(plan?.events).toEqual([note, link]);
    expect(plan?.outcome).toBe("text-changed");
  });

  test("an override recorded before reasons were required still follows", () => {
    const legacy = event({ kind: "override", state: "tension" });
    const plan = planClaimCarry({
      source: SUPPORTED,
      events: [legacy],
      target: SUPPORTED,
      wording: "same",
    });
    expect(plan?.events).toEqual([legacy]);
    expect(plan?.events.at(0)?.payload.reason).toBeUndefined();
  });
});
