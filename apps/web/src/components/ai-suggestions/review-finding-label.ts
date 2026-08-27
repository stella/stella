/**
 * What a finding's judgment reads as, in words.
 *
 * There is no glyph column any more: a reviewer opening the panel for the
 * first time cannot be expected to know that ▼ means "worse for your side"
 * and ○ means "the document does not have this at all". Every map here is
 * total over the vocabulary the engine writes, so a verdict, impact, or
 * severity added on the server has to state its word before it can render.
 *
 * The maps hold translation keys rather than words: the judgment is decided
 * here, where it can be tested without a locale, and rendered by
 * `useReviewLabels` where one is available.
 */

import { useTranslations } from "use-intl";

import type { ReviewPerspective } from "@/components/ai-suggestions/document-review-basis.logic";
import type {
  ReviewFinding,
  ReviewSeverity,
  ReviewVerdict,
} from "@/components/ai-suggestions/document-review-queries";
import type { ReviewImpact } from "@/components/ai-suggestions/review-delta";
import type { TranslationKey } from "@/i18n/types";

const VERDICT_LABEL_KEYS = {
  compliant: "knowledge.playbooks.verdict.compliant",
  fallback: "knowledge.playbooks.verdict.fallback",
  deviation: "knowledge.playbooks.verdict.deviation",
  missing: "knowledge.playbooks.verdict.missing",
  additional: "knowledge.playbooks.verdict.additional",
  "not-applicable": "knowledge.playbooks.verdict.notApplicable",
} as const satisfies Record<ReviewVerdict, TranslationKey>;

/** A run that judged no direction and reached no verdict compared nothing. */
const NOT_COMPARED_LABEL_KEY = "inspector.review.notCompared";

export type DirectedImpact = Exclude<ReviewImpact, "unknown">;

/** An impact the card can put a direction on; `unknown` and findings the run
 *  never judged for a side fall back to the verdict. */
export const isDirectedImpact = (
  impact: ReviewFinding["impact"],
): impact is DirectedImpact => impact !== undefined && impact !== "unknown";

// Labels name the side so "worse" is never ambiguous on a printed or shared
// card.
const IMPACT_LABEL_KEYS = {
  unfavourable: "inspector.review.impact.unfavourable",
  favourable: "inspector.review.impact.favourable",
  neutral: "inspector.review.impact.neutral",
} as const satisfies Record<DirectedImpact, TranslationKey>;
const IMPACT_FOR_SIDE_LABEL_KEYS = {
  unfavourable: "inspector.review.impactForSide.unfavourable",
  favourable: "inspector.review.impactForSide.favourable",
  neutral: "inspector.review.impactForSide.neutral",
} as const satisfies Record<DirectedImpact, TranslationKey>;

type PlainLabelKey =
  | (typeof VERDICT_LABEL_KEYS)[ReviewVerdict]
  | typeof NOT_COMPARED_LABEL_KEY
  | (typeof IMPACT_LABEL_KEYS)[DirectedImpact];

type ForSideLabelKey = (typeof IMPACT_FOR_SIDE_LABEL_KEYS)[DirectedImpact];

/**
 * One judgment, ready to render: a key on its own, or a key plus the role it
 * names. A union rather than a pre-formatted string so the decision stays
 * testable and the wording stays in the catalogs.
 */
export type ReviewLabelMessage =
  | { type: "plain"; key: PlainLabelKey }
  | { type: "forSide"; key: ForSideLabelKey; role: string };

export const impactLabelMessage = (
  impact: DirectedImpact,
  perspective: ReviewPerspective,
): ReviewLabelMessage =>
  perspective.type === "party"
    ? {
        type: "forSide",
        key: IMPACT_FOR_SIDE_LABEL_KEYS[impact],
        role: perspective.role,
      }
    : { type: "plain", key: IMPACT_LABEL_KEYS[impact] };

/**
 * The judgment in one phrase: the direction the run judged for, the verdict
 * when it judged no direction, and "Missing" for a standard the document has
 * nothing to answer with — checked before impact, because "nothing to compare"
 * is a different finding from "no verdict either way".
 */
export const findingLabelMessage = (
  finding: ReviewFinding,
  perspective: ReviewPerspective,
): ReviewLabelMessage => {
  const { verdict, impact } = finding;
  if (verdict === "missing") {
    return { type: "plain", key: VERDICT_LABEL_KEYS.missing };
  }
  const resolvedImpact = impact ?? "unknown";
  if (isDirectedImpact(resolvedImpact)) {
    return impactLabelMessage(resolvedImpact, perspective);
  }
  return {
    type: "plain",
    key:
      verdict === null ? NOT_COMPARED_LABEL_KEY : VERDICT_LABEL_KEYS[verdict],
  };
};

/**
 * Which severities are worth repeating on the card. The list is already sorted
 * worst first, so naming every level would only restate the row's position;
 * the two that stop a deal are the ones a reviewer scanning the list has to
 * see without opening anything.
 */
const SEVERITY_WORD_KEYS = {
  blocker: "knowledge.playbooks.severity.blocker",
  high: "knowledge.playbooks.severity.high",
  medium: null,
  low: null,
} as const satisfies Record<ReviewSeverity, TranslationKey | null>;

export type FindingHeaderLabelMessage = {
  /** The severity word, or `null` where the row's place already says it. */
  severityKey: (typeof SEVERITY_WORD_KEYS)[ReviewSeverity];
  judgment: ReviewLabelMessage;
};

/** The card header's right-aligned label, before it is put into words. */
export const findingHeaderLabelMessage = (
  finding: ReviewFinding,
  perspective: ReviewPerspective,
): FindingHeaderLabelMessage => ({
  severityKey: SEVERITY_WORD_KEYS[finding.severity],
  judgment: findingLabelMessage(finding, perspective),
});

const LABEL_SEPARATOR = " · ";

/** The judgments of the review surface, in the reader's language. */
export const useReviewLabels = () => {
  const t = useTranslations();
  const label = (message: ReviewLabelMessage): string =>
    message.type === "forSide"
      ? t(message.key, { role: message.role })
      : t(message.key);

  return {
    reviewLabel: label,
    impactLabel: (impact: DirectedImpact, perspective: ReviewPerspective) =>
      label(impactLabelMessage(impact, perspective)),
    findingLabel: (finding: ReviewFinding, perspective: ReviewPerspective) =>
      label(findingLabelMessage(finding, perspective)),
    /** `High · Unfavourable`. */
    findingHeaderLabel: (
      finding: ReviewFinding,
      perspective: ReviewPerspective,
    ) => {
      const { severityKey, judgment } = findingHeaderLabelMessage(
        finding,
        perspective,
      );
      const words = label(judgment);
      return severityKey === null
        ? words
        : `${t(severityKey)}${LABEL_SEPARATOR}${words}`;
    },
  };
};
