/**
 * What one filter section shows: the buckets the current result set reports,
 * trimmed to a scannable head, with the reader's own choice always among them.
 */

/** One choice in a facet section. `count` is null when no number is known. */
export type FacetItem = {
  value: string;
  label: string;
  count: number | null;
};

export type FacetSectionView = {
  items: readonly FacetItem[];
  /** Items the trim left out; zero once the section is expanded. */
  hiddenCount: number;
};

/** A bucket as either facet source reports it. */
export type FacetSourceBucket = {
  value: string;
  label?: string | null | undefined;
  count?: number | null | undefined;
};

export type FacetSectionOptions = {
  buckets: readonly FacetSourceBucket[];
  /** How many items show before "Show all". */
  limit: number;
  expanded: boolean;
  /** The value the URL selects in this section, if any. */
  selectedValue: string | undefined;
};

const toItem = (bucket: FacetSourceBucket): FacetItem => ({
  value: bucket.value,
  label: bucket.label ?? bucket.value,
  count: bucket.count ?? null,
});

/**
 * A section's visible items.
 *
 * The selected value survives two ways of disappearing. Cross-filtered counts
 * exclude a facet's own selection, but a bucket can still drop out of the
 * page's facets (another filter narrowed it away, or a cursor page carries no
 * facets at all); then it is re-added, with no count, because a filter the
 * reader cannot see is a filter they cannot clear. And a selection ranked
 * below the trim is appended rather than dropped, for the same reason.
 */
export const facetSectionView = ({
  buckets,
  expanded,
  limit,
  selectedValue,
}: FacetSectionOptions): FacetSectionView => {
  const items = buckets.map(toItem);
  if (
    selectedValue !== undefined &&
    !items.some((item) => item.value === selectedValue)
  ) {
    items.unshift({ value: selectedValue, label: selectedValue, count: null });
  }

  if (expanded || items.length <= limit) {
    return { items, hiddenCount: 0 };
  }

  const shown = items.slice(0, limit);
  const selected =
    selectedValue === undefined
      ? undefined
      : items.find((item) => item.value === selectedValue);
  if (selected !== undefined && !shown.includes(selected)) {
    shown.push(selected);
  }
  return { items: shown, hiddenCount: items.length - shown.length };
};

/** How many items a section shows before it offers to show them all. */
export const FACET_SECTION_LIMIT = 8;
