/**
 * Match a provision link to its selected consolidation. Existing links infer
 * the wording from the decision date; that date does not establish which
 * wording the court applied.
 */

import { isEligibleLegislationExpression } from "@stll/api-contract/legislation-expression";
import type { LegislationExpressionEligibility } from "@stll/api-contract/legislation-expression";
import { provisionVersionAsOf } from "@stll/api-contract/provision-version-basis";

export type StatuteVersionWindow = LegislationExpressionEligibility & {
  /** Opens the window; null for a work kept as a single unversioned text. */
  versionValidFrom: string | null;
  /** Closes it, exclusive; null while the version is the one in force. */
  versionValidTo: string | null;
};

/**
 * The corpus half-open interval `[from, to)`: a version whose successor opens
 * on a date ends on that date. Dates are ISO date-only, which orders
 * correctly as text.
 *
 * Only an eligible version covers any date: one that never took effect, one
 * whose publisher dates are inconsistent, a withdrawn one or a promulgated
 * text keeps its stored dates as history, but a citation is never linked to
 * it as the wording in force.
 */
export const versionCoversDate = (
  version: StatuteVersionWindow,
  date: string,
): boolean =>
  isEligibleLegislationExpression(version) &&
  (version.versionValidFrom === null || version.versionValidFrom <= date) &&
  (version.versionValidTo === null || version.versionValidTo > date);

/** The consolidation in force on `date`, or null when the corpus holds none. */
export const pickVersionAt = <TVersion extends StatuteVersionWindow>(
  versions: readonly TVersion[],
  date: string,
): TVersion | null =>
  versions.find((version) => versionCoversDate(version, date)) ?? null;

type ReferencesOutsideVersionOptions = {
  decisionAsOf: string | null;
  references: readonly Parameters<typeof provisionVersionAsOf>[0][];
};

/**
 * Whether a work's other consolidations have to be read: some reference
 * selects a version the resolved consolidation does not cover. A reference to
 * wording that consolidation still carries is answered by it alone, which is
 * why the versions read is not started for it.
 */
export const referencesOutsideVersion = (
  version: StatuteVersionWindow,
  { decisionAsOf, references }: ReferencesOutsideVersionOptions,
): boolean =>
  references.some((reference) => {
    const asOf = provisionVersionAsOf(reference, decisionAsOf);
    return asOf !== null && !versionCoversDate(version, asOf);
  });
