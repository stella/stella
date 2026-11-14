/**
 * How the verification view reads a claim's staleness. The server decides
 * which claims are out of date and why (`staleness` on each claim); this
 * file owns only how each reason reads and which claims the run line, the
 * filter and the bulk re-check act on.
 */

import type { ReviewStatusTone } from "@stll/ui/review-status-badge";

import type {
  StalenessReason,
  StalenessReasonKind,
  VerificationClaim,
} from "@/features/avt/types";
import type { TranslationKey } from "@/i18n/types";

type ReasonMeta = {
  labelKey: TranslationKey;
  /** A fact the grade cites changed: the grade is out of date. A new fact
   *  only may bear on it, so it reads neutral. */
  tone: ReviewStatusTone;
};

export const STALENESS_REASON_META = {
  "fact-changed": {
    labelKey: "avt.staleness.reasons.factChanged",
    tone: "warning",
  },
  "fact-removed": {
    labelKey: "avt.staleness.reasons.factRemoved",
    tone: "warning",
  },
  "fact-held": { labelKey: "avt.staleness.reasons.factHeld", tone: "warning" },
  "new-fact-related": {
    labelKey: "avt.staleness.reasons.newFactRelated",
    tone: "neutral",
  },
} as const satisfies Record<StalenessReasonKind, ReasonMeta>;

type QualifierKind = VerificationClaim["qualifiers"][number]["kind"];

/**
 * Qualifiers a staleness reason says for the same fact and the same cause.
 * A cited fact held since the grade is both `rests-on-held` (a caveat) and
 * `fact-held` (a reason to re-check, with the action beside it); the reason
 * is the one shown, so the panel says it once. Total over qualifiers, so a
 * new one is decided here.
 */
const QUALIFIER_SAID_BY_REASON = {
  "record-silent": null,
  "scope-mismatch": null,
  "testimony-only": null,
  "unsourced-only": null,
  "rests-on-held": "fact-held",
} as const satisfies Record<QualifierKind, StalenessReasonKind | null>;

/** The qualifiers a claim's chips show: those no staleness reason of the
 *  claim already says. */
export const qualifiersBesideStaleness = <
  Qualifier extends { kind: QualifierKind },
>(
  qualifiers: readonly Qualifier[],
  staleness: VerificationClaim["staleness"],
): Qualifier[] => {
  const said = new Set(
    staleness === null ? [] : staleness.map((reason) => reason.kind),
  );
  return qualifiers.filter((qualifier) => {
    const reason = QUALIFIER_SAID_BY_REASON[qualifier.kind];
    return reason === null || !said.has(reason);
  });
};

type StaleTarget = Pick<VerificationClaim, "staleness">;

/** Whether the claim's grade may no longer stand on the list as it is now.
 *  A list too large to read whole (`null`) says nothing either way. */
export const isOutOfDate = ({ staleness }: StaleTarget): boolean =>
  staleness !== null && staleness.length > 0;

/** Whether the notice warns (a cited fact changed) or only says new facts
 *  may bear on the claim. */
export const stalenessTone = (
  reasons: readonly StalenessReason[],
): "warning" | "muted" =>
  reasons.some(
    (reason) => STALENESS_REASON_META[reason.kind].tone === "warning",
  )
    ? "warning"
    : "muted";

/** The claims whose grade may no longer stand, in reading order: what the
 *  run line counts, its filter steps through and its re-check sends. */
export const outOfDateIdsIn = <Id extends string>(
  readingOrder: readonly Id[],
  claimById: ReadonlyMap<Id, StaleTarget>,
): Id[] =>
  readingOrder.filter((id) => {
    const claim = claimById.get(id);
    return claim !== undefined && isOutOfDate(claim);
  });
