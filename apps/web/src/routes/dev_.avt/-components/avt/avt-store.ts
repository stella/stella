/**
 * AVT — client-side store for anchor-fact edits and per-claim review
 * state. In-memory only (no persistence, no backend) for this pass —
 * matches the "vibecode a rough version" scope. `facts` are seeded
 * from the sample record so edits made in the anchor-facts panel are
 * visible everywhere a fact is cited (detail cards, record-conflict
 * resolution), rather than each screen holding its own copy.
 */

import { create } from "zustand";

import { Temporal } from "@stll/time";

import { ANCHOR_FACTS } from "@/routes/dev_.avt/-components/avt/sample-data";
import type {
  AnchorFact,
  ClaimReview,
  ConfidenceLevel,
  RecordConflictResolution,
  ReviewerOverrideState,
  ReviewStatus,
} from "@/routes/dev_.avt/-components/avt/types";
import { EMPTY_REVIEW } from "@/routes/dev_.avt/-components/avt/types";

/** Store an absolute instant; UI owners localize it for the viewer. */
const nowInstant = (): string => Temporal.Now.instant().toString();

const seedFacts = (): Record<string, AnchorFact> => {
  const facts: Record<string, AnchorFact> = {};
  for (const fact of ANCHOR_FACTS) {
    facts[fact.id] = { ...fact };
  }
  return facts;
};

type AvtState = {
  facts: Record<string, AnchorFact>;
  reviews: Record<string, ClaimReview>;
};

type AvtActions = {
  setFactConfidence: (factId: string, confidence: ConfidenceLevel) => void;
  acceptFact: (factId: string) => void;
  editFact: (factId: string, text: string) => void;

  setReviewStatus: (claimId: string, status: ReviewStatus | null) => void;
  setOverride: (
    claimId: string,
    override: ReviewerOverrideState | null,
  ) => void;
  setNote: (claimId: string, note: string) => void;
  bulkSetReviewed: (claimIds: readonly string[]) => void;
  reopenClaim: (claimId: string) => void;
  resolveRecordConflict: (
    claimId: string,
    resolution: RecordConflictResolution | null,
  ) => void;
};

const patchReview = (
  state: AvtState,
  claimId: string,
  patch: Partial<ClaimReview>,
): Pick<AvtState, "reviews"> => ({
  reviews: {
    ...state.reviews,
    [claimId]: { ...(state.reviews[claimId] ?? EMPTY_REVIEW), ...patch },
  },
});

export const useAvtStore = create<AvtState & AvtActions>()((set) => ({
  facts: seedFacts(),
  reviews: {},

  setFactConfidence: (factId, confidence) => {
    set((state) => {
      const fact = state.facts[factId];
      if (!fact) {
        return state;
      }
      return { facts: { ...state.facts, [factId]: { ...fact, confidence } } };
    });
  },

  acceptFact: (factId) => {
    set((state) => {
      const fact = state.facts[factId];
      if (!fact) {
        return state;
      }
      return {
        facts: {
          ...state.facts,
          [factId]: { ...fact, flag: false, accepted: true },
        },
      };
    });
  },

  editFact: (factId, text) => {
    set((state) => {
      const fact = state.facts[factId];
      if (!fact) {
        return state;
      }
      return {
        facts: {
          ...state.facts,
          [factId]: { ...fact, fact: text, flag: false, accepted: true },
        },
      };
    });
  },

  setReviewStatus: (claimId, status) => {
    set((state) =>
      patchReview(state, claimId, { status, decisionAt: nowInstant() }),
    );
  },

  setOverride: (claimId, override) => {
    set((state) =>
      patchReview(state, claimId, { override, decisionAt: nowInstant() }),
    );
  },

  setNote: (claimId, note) => {
    set((state) =>
      patchReview(state, claimId, {
        note,
        savedAt: note
          ? nowInstant()
          : (state.reviews[claimId]?.savedAt ?? null),
      }),
    );
  },

  /** One audit-trail action for the long tail of routine, not-yet-settled claims. */
  bulkSetReviewed: (claimIds) => {
    if (claimIds.length === 0) {
      return;
    }
    const decisionAt = nowInstant();
    set((state) => {
      const reviews = { ...state.reviews };
      for (const claimId of claimIds) {
        const current = reviews[claimId] ?? EMPTY_REVIEW;
        if (current.status === "reviewed" || current.status === "disputed") {
          continue;
        }
        reviews[claimId] = {
          ...current,
          status: "reviewed",
          decisionAt,
          bulk: true,
        };
      }
      return { reviews };
    });
  },

  /**
   * Re-open a set-aside claim: the reviewer has decided it IS a
   * checkable fact. No live model is wired up in this build, so this
   * always lands on the same deterministic fallback the prototype uses
   * offline — "no coverage, pending check".
   *
   * `resolveClaimView` derives the resulting `nocover` state from
   * `reopened` alone, so no `override` is written here: an override is a
   * reviewer's annotation sitting alongside the tool's verdict, and
   * recording one made a re-opened claim render an "Overridden to No
   * coverage" badge nobody asked for, contradicting the panel's own
   * "pending check" message.
   *
   * Any earlier `status` and `override` are cleared, because both
   * described the claim as it was BEFORE the reclassification. Left in
   * place, a claim previously marked reviewed stayed settled while
   * pending a re-check, and a stale override still won in
   * `effectiveState` — so the tiles and underlines went on showing the
   * superseded verdict rather than the pending one.
   */
  reopenClaim: (claimId) => {
    set((state) =>
      patchReview(state, claimId, {
        reopened: true,
        status: null,
        override: null,
        decisionAt: nowInstant(),
      }),
    );
  },

  resolveRecordConflict: (claimId, resolution) => {
    set((state) =>
      patchReview(state, claimId, {
        recordConflictResolution: resolution,
        status: null,
        override: null,
        decisionAt: nowInstant(),
      }),
    );
  },
}));
