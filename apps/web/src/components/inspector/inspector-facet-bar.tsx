import { useTranslations } from "use-intl";

import { InspectorFacetBar } from "@stll/ui/inspector";

type FacetBarProps<F extends string> = {
  facet: F;
  facets: readonly F[];
  /** Display label per facet. */
  labels: Record<F, string>;
  /**
   * Facets rendered but not interactive — visible so users can find
   * them, but clicking does nothing (e.g. an AI-suggestions chip
   * before any proposals exist).
   */
  disabledFacets?: ReadonlySet<F> | undefined;
  pulseSeq?: number | undefined;
  /**
   * Suffix appended to the active facet's label, e.g. `"v1"` →
   * "Preview · v1". Hidden on inactive chips so the row stays
   * scannable.
   */
  activeBadge?: string | undefined;
  onChange: (next: F) => void;
};

/**
 * Inspector subtab row: a single line of pill chips at toolbar-row
 * height. Thin wrapper over `@stll/ui/inspector`'s `InspectorFacetBar` —
 * this only supplies the translated overflow-menu label, since the
 * shared component doesn't own copy.
 */
export const FacetBar = <F extends string>(props: FacetBarProps<F>) => {
  const t = useTranslations();
  return (
    <InspectorFacetBar overflowMenuLabel={t("common.showMore")} {...props} />
  );
};
