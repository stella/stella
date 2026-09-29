import {
  isEligibleLegislationExpression,
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";
import type {
  LegislationExpressionEligibility,
  LegislationInconsistentVersion,
  LegislationWindowDisposition,
} from "@stll/api-contract/legislation-expression";

import type { TranslationKey } from "@/i18n/types";

/**
 * What a version that can never apply is called in place of a period in
 * force. Its dates stay visible as the publisher stated them; the label is
 * what stops them reading as a time the text applied.
 */
const INELIGIBLE_EXPRESSION_LABEL_KEYS = {
  "never-in-force": "statutes.status.neverInForce",
  "invalid-window": "statutes.expression.invalidWindow",
  withdrawn: "statutes.expression.withdrawn",
  // An effective window that still cannot apply belongs to a promulgated
  // text, which sits beside the consolidations and never answers for them.
  effective: "statutes.expression.promulgated",
} as const satisfies Record<LegislationWindowDisposition, TranslationKey>;

type IneligibleExpressionLabelKey =
  (typeof INELIGIBLE_EXPRESSION_LABEL_KEYS)[LegislationWindowDisposition];

/**
 * The label a version carries instead of an in-force period, or null for a
 * version that can apply. The API decides eligibility by the same rule
 * (`isEligibleLegislationExpression`), so the reader never labels a version
 * the corpus answers with, nor presents one it never answers with as in
 * force.
 */
export const ineligibleExpressionLabelKey = (
  version: LegislationExpressionEligibility,
): IneligibleExpressionLabelKey | null =>
  isEligibleLegislationExpression(version)
    ? null
    : INELIGIBLE_EXPRESSION_LABEL_KEYS[version.windowDisposition];

/**
 * A date the publisher's own inconsistent dates leave without an in-force
 * reading, with the versions responsible as the publisher stated them.
 */
export type StatuteWindowGap = {
  windowGap: readonly LegislationInconsistentVersion[];
};

/** Whether a slug read answered with the publisher-data gap. */
export const isStatuteWindowGap = (value: unknown): value is StatuteWindowGap =>
  typeof value === "object" && value !== null && "windowGap" in value;

/**
 * The eligibility fields read off untyped data (a route's loader data), or
 * null when they are absent or not values the contract knows.
 */
export const readExpressionEligibility = (
  expressionKind: string | null,
  windowDisposition: string | null,
): LegislationExpressionEligibility | null => {
  const kind = LEGISLATION_EXPRESSION_KINDS.find(
    (known) => known === expressionKind,
  );
  const disposition = LEGISLATION_WINDOW_DISPOSITIONS.find(
    (known) => known === windowDisposition,
  );
  return kind === undefined || disposition === undefined
    ? null
    : { expressionKind: kind, windowDisposition: disposition };
};
