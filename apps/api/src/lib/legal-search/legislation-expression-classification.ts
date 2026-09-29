import type {
  LegislationExpressionKind,
  LegislationWindowDisposition,
  LegislationWindowDispositionBasis,
} from "@stll/api-contract/legislation-expression";

/** What a stored version is, and whether and why its window can apply. */
export type LegislationExpressionClassification = {
  expressionKind: LegislationExpressionKind;
  windowDisposition: LegislationWindowDisposition;
  windowDispositionBasis: LegislationWindowDispositionBasis | null;
};

/**
 * What a version is when nothing says otherwise, and what every column
 * defaults to: an effective consolidation window.
 */
export const EFFECTIVE_CONSOLIDATION = {
  expressionKind: "consolidation",
  windowDisposition: "effective",
  windowDispositionBasis: null,
} as const satisfies LegislationExpressionClassification;

/**
 * The kinds a version could carry before a writer could state its kind: a
 * consolidation, or a work kept as one text. Which of the two follows from the
 * stored window alone, which every digest already covers.
 */
const UNTYPED_KINDS: readonly LegislationExpressionKind[] = [
  "consolidation",
  "unversioned",
];

/**
 * Whether a version carries the classification every stored version carried
 * before classifications could be written: an effective window, no basis, and
 * a kind its window already implies.
 */
export const isUntypedLegislationClassification = ({
  expressionKind,
  windowDisposition,
  windowDispositionBasis,
}: LegislationExpressionClassification): boolean =>
  windowDisposition === "effective" &&
  windowDispositionBasis === null &&
  UNTYPED_KINDS.includes(expressionKind);

/**
 * What a digest over a version (its source hash, its projection fingerprint)
 * folds in for the classification: nothing for an untyped version, so every
 * digest written before classifications existed keeps its bytes and nothing
 * is rewritten or re-projected for it, and the whole classification
 * otherwise, so a change to it moves the digest.
 */
export const typedLegislationClassification = (
  classification: LegislationExpressionClassification,
): LegislationExpressionClassification | null =>
  isUntypedLegislationClassification(classification)
    ? null
    : {
        expressionKind: classification.expressionKind,
        windowDisposition: classification.windowDisposition,
        windowDispositionBasis: classification.windowDispositionBasis,
      };
