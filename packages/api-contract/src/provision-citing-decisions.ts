/** Pageable orderings for decisions mentioning one statute provision. */
export const PROVISION_CITING_DECISION_SORTS = ["newest", "citations"] as const;

export const PROVISION_CITING_FILTER_LIMITS = {
  courtChars: 512,
  yearMin: 1,
  yearMax: 9998,
} as const;
