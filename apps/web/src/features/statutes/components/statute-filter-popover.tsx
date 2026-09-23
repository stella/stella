import { useTranslations } from "use-intl";

import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";

import type { FacetSourceBucket } from "@/components/public-law-table/public-law-facets.logic";
import {
  FacetSection,
  PublicLawFilterPopover,
} from "@/components/public-law-table/public-law-filter-popover";
import { STATUTE_VALIDITY_LABEL_KEYS } from "@/features/statutes/statute-columns.logic";
import type { StatuteFilterKey } from "@/features/statutes/statute-filters.logic";

type StatuteFilterPopoverProps = {
  /** How many filters are on; drawn on the button, so a short list is explained. */
  activeFilterCount: number;
  onSelect: (key: StatuteFilterKey, value: string | undefined) => void;
  selection: Record<StatuteFilterKey, string | undefined>;
  /** The kinds of act the jurisdiction holds, with how many Works each has. */
  types: readonly FacetSourceBucket[];
};

/**
 * The statute facets in the shared public-law filter popover: whether the act
 * still applies, and what kind of act it is.
 */
export const StatuteFilterPopover = ({
  activeFilterCount,
  onSelect,
  selection,
  types,
}: StatuteFilterPopoverProps) => {
  const t = useTranslations();
  const validities = LEGISLATION_LIST_VALIDITIES.map((validity) => ({
    value: validity,
    label: t(STATUTE_VALIDITY_LABEL_KEYS[validity]),
  }));

  return (
    <PublicLawFilterPopover activeFilterCount={activeFilterCount}>
      <FacetSection
        buckets={validities}
        heading={t("common.status")}
        name="validity"
        onSelect={(value) => onSelect("validity", value)}
        selectedValue={selection.validity}
      />
      <FacetSection
        buckets={types}
        heading={t("common.type")}
        name="type"
        onSelect={(value) => onSelect("type", value)}
        selectedValue={selection.type}
      />
    </PublicLawFilterPopover>
  );
};
