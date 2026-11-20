import { useTranslations } from "use-intl";

import { PublicLawSearchFace } from "@/components/public-law-search.pending";
import { STATUTE_MAX_QUERY_LENGTH } from "@/features/statutes/statute-index-search.logic";

/** What the statutes box is called and asks for, said once for box and face. */
export const useStatuteSearchWords = () => {
  const t = useTranslations();
  return {
    placeholder: t("statutes.searchPlaceholder"),
    searchLabel: t("statutes.searchLabel"),
  };
};

/** The statutes box before its page is there; see `PublicLawSearchFace`. */
export const StatuteSearchFace = () => {
  const { placeholder, searchLabel } = useStatuteSearchWords();
  return (
    <PublicLawSearchFace
      maxLength={STATUTE_MAX_QUERY_LENGTH}
      placeholder={placeholder}
      searchLabel={searchLabel}
    />
  );
};
