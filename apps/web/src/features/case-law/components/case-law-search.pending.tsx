import { PublicLawSearchFace } from "@/components/public-law-search.pending";

export const CASE_LAW_SEARCH_PLACEHOLDER = "caseLaw.searchPlaceholder";

export const CaseLawSearchFace = () => (
  <PublicLawSearchFace placeholder={CASE_LAW_SEARCH_PLACEHOLDER} refine />
);
