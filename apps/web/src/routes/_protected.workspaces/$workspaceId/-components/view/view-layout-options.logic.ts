import type { ViewLayoutType } from "@/lib/api-contract";

/**
 * Layouts neither the "+" menu nor the preset picker offers: one the matter
 * already holds once, and AVT for a caller without the verification feature.
 */
export const unavailableViewLayouts = ({
  heldSingleLayouts,
  avtEnabled,
}: {
  heldSingleLayouts: ReadonlySet<ViewLayoutType>;
  avtEnabled: boolean;
}): ReadonlySet<ViewLayoutType> =>
  new Set<ViewLayoutType>([
    ...heldSingleLayouts,
    ...(avtEnabled ? [] : ["avt" as const]),
  ]);
