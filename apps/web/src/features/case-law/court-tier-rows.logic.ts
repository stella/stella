import {
  type CourtTier,
  isCourtTier,
} from "@/features/case-law/decision-filter-facets.logic";

/** One tier's heading and the court rows it stands over. */
export type CourtTierGroup<TRow> = { tier: CourtTier; rows: TRow[] };

/**
 * A tier the UI has a heading for. A label it does not know folds into the
 * catch-all, exactly as the facet rail folds one: a court the reader cannot
 * see is a court they cannot account for.
 */
const uiTier = (tier: string): CourtTier =>
  isCourtTier(tier) ? tier : "other";

/**
 * Court rows under the tier headings the facet rail already uses, so every
 * surface that draws this breakdown draws one classification of the courts.
 *
 * The API returns the rows already ordered apex first, and a Map keeps the
 * order its keys arrived in, so the headings come out in that order without a
 * second sort here: re-ordering would be a second ranking of the same courts,
 * and the two would drift.
 */
export const groupCourtRowsByTier = <TRow extends { tier: string }>(
  courts: readonly TRow[],
): readonly CourtTierGroup<TRow>[] => {
  const rowsByTier = new Map<CourtTier, TRow[]>();
  for (const row of courts) {
    const tier = uiTier(row.tier);
    const open = rowsByTier.get(tier);
    if (open === undefined) {
      rowsByTier.set(tier, [row]);
      continue;
    }
    open.push(row);
  }
  return [...rowsByTier].map(([tier, rows]) => ({ rows, tier }));
};

/** A row's identity within a breakdown; a tier row stands for its whole tier. */
export const courtTierRowKey = (
  row: { type: "court"; court: string } | { type: "tier"; tier: string },
): string => (row.type === "court" ? row.court : row.tier);
