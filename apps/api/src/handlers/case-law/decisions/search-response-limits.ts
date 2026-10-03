import { LIMITS } from "@/api/lib/limits";

// Stored varchar character limits permit four UTF-8 bytes per scalar. Free
// display text (headlines, abbreviations and warnings) has an explicit budget.
export const CASE_SEARCH_TEXT_BYTES = {
  id: 128,
  caseNumber: 256 * 4,
  identifier: 256 * 4,
  slug: 256 * 4,
  court: 512 * 4,
  courtAbbreviation: 256,
  country: 3 * 4,
  language: 8 * 4,
  date: 128,
  decisionType: 128 * 4,
  sourceUrl: 2048 * 4,
  headline: 16_384,
  anchorId: 1024,
  facet: 512 * 4,
  label: 256 * 4,
  queryUsed: LIMITS.searchQueryMaxLength * 4,
  warning: 16_384,
} as const;
