import { useTranslations } from "use-intl";

import {
  publicLawAskScope,
  PublicLawSearch,
} from "@/components/public-law-search";
import type { PublicLawAskScope } from "@/components/public-law-search";
import { fromCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import type { CaseLawRefine } from "@/features/case-law/use-case-law-refine";
import { useFormatter } from "@/i18n/formatting-context";
import { caseLawCountryName } from "@/lib/case-law-route";

type CaseLawSearchProps = {
  /** The jurisdiction the page is scoped to, as a country param. */
  country: string;
  maxLength: number;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  query: string;
  /** The wand: the page owns the rewrite, which its empty results reuse. */
  refine: CaseLawRefine;
};

/**
 * The case-law browser's instance of the shared public-law box: a docket
 * number, an ECLI or words. Dockets repeat across countries, so the chat
 * prompt carries the scope even though the row no longer shows it — the
 * jurisdiction is chosen once, in the top bar.
 *
 * It leads the results screen: there is nothing above the list but this, so
 * the box is what the reader lands on and everything that narrows the list
 * sits below it.
 *
 * The wand rewrites a question into the words the jurisdiction's decisions
 * use ("kauce" becomes "jistota"): every word of a case-law search is
 * required, and a judgment is not written the way a question is asked.
 */
export const CaseLawSearch = ({
  country,
  maxLength,
  onQueryChange,
  onSubmit,
  query,
  refine,
}: CaseLawSearchProps) => {
  const t = useTranslations();
  const askScope = useCaseLawAskScope(country);

  return (
    <PublicLawSearch
      askScope={askScope}
      maxLength={maxLength}
      onQueryChange={onQueryChange}
      onSubmit={onSubmit}
      placeholder={t("caseLaw.searchPlaceholder")}
      query={query}
      refine={{ isPending: refine.isPending, onRefine: refine.onRefine }}
      searchLabel={t("caseLaw.searchLabel")}
    />
  );
};

/**
 * The corpus "Ask in chat" scopes a case-law question to, wherever the page
 * offers it (the box, the empty results).
 */
export const useCaseLawAskScope = (
  country: string,
): PublicLawAskScope | null => {
  const t = useTranslations();
  const format = useFormatter();
  const code = fromCaseLawCountryParam(country);
  return publicLawAskScope(
    "case_law",
    code,
    t("chat.mention.corpus.caseLaw", {
      country: caseLawCountryName(format, code),
    }),
  );
};
