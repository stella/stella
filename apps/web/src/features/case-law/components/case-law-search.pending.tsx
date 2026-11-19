import { useTranslations } from "use-intl";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";

import { PublicLawSearchFace } from "@/components/public-law-search.pending";

/** What the case-law box is called and asks for, said once for box and face. */
export const useCaseLawSearchWords = () => {
  const t = useTranslations();
  return {
    placeholder: t("caseLaw.searchPlaceholder"),
    searchLabel: t("caseLaw.searchLabel"),
  };
};

/** The case-law box before its page is there; see `PublicLawSearchFace`. */
export const CaseLawSearchFace = () => {
  const { placeholder, searchLabel } = useCaseLawSearchWords();
  return (
    <PublicLawSearchFace
      maxLength={SEARCH_QUERY_MAX_LENGTH}
      placeholder={placeholder}
      refine
      searchLabel={searchLabel}
    />
  );
};
