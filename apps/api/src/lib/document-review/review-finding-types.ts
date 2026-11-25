// Leaf finding shapes shared by the persisted review run contract
// (`run-contract.ts`) and the grading engine (`review-grade.ts`), without
// pulling the AI grading engine or provider SDKs into `db/schema/*`.

import type { VerdictMatchedRef } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  DocxFolioCitation,
  GroundedReviewFix,
  ReferenceConsensus,
  ReferenceImpact,
} from "@/api/lib/document-review/contract";
import type { ReviewDelta } from "@/api/lib/document-review/review-delta";
import type {
  PositionSeverity,
  PositionStandardSource,
} from "@/api/lib/workflow/playbook-positions";
import type {
  ExtractedAskValue,
  VerdictTier,
} from "@/api/lib/workflow/verdict-tiers";

/** A one-click redline, derived from the finding's delta, in the folio
 *  editor's AI-edit op vocabulary. */
export type ReviewFix = GroundedReviewFix;

export type ReviewFinding = {
  positionId: string;
  issue: string;
  severity: PositionSeverity;
  /** Where the standard this was graded against came from. Kept on the
   *  finding so a reader knows what the judgment rests on without re-reading
   *  the run's pinned position list. */
  standardSource: PositionStandardSource;
  // null for extract-only positions (a value column with no verdict).
  verdict: VerdictTier | null;
  /** What differs, typed. The fix is derived from this, never free-formed. */
  delta: ReviewDelta;
  extracted: ExtractedAskValue | null;
  rationale: string | null;
  // The resolved tier reference a tier-match verdict cited (which fallback
  // matched, or which red line was violated). Absent for deterministic or
  // unmatched verdicts.
  matchedRef?: VerdictMatchedRef;
  /** How consistently the standard's own passages agreed. Reference standards
   *  only: an authored ladder is one voice by construction. */
  consensus?: ReferenceConsensus;
  /** Which way the difference cuts for the side the run was judged for. */
  impact?: ReferenceImpact;
  /** The comparison in prose, or the statement that there was not enough to
   *  compare. Reference standards only; a tier match explains itself through
   *  `rationale` and `matchedRef`. */
  explanation?:
    { type: "comparison"; text: string } | { type: "insufficient-evidence" };
  /** One instruction for the drafter, or `null` when nothing should change. */
  recommendation?: string | null;
  citations: DocxFolioCitation[];
  /** The standard's own passages, grouped by the document they came from.
   *  Ids only: the words live in their source matter's rows and reach a
   *  reader through that matter's row security, never through the finding. */
  referenceCitations?: {
    fileFieldId: SafeId<"field">;
    passages: { id: string; blockId: string }[];
  }[];
  fix: ReviewFix | null;
};
