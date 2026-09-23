import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { PublicLawSearch } from "@/components/public-law-search";
import {
  caseLawCountryRegion,
  fromCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { refineCaseLawQuery } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";
import { useI18nStore } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";

type CaseLawSearchProps = {
  /** The jurisdiction the page is scoped to, as a country param. */
  country: string;
  maxLength: number;
  onQueryChange: (value: string) => void;
  /** The AI rewrite landed: search for it in place of the entry. */
  onRefined: (query: string) => void;
  onSubmit: () => void;
  query: string;
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
  onRefined,
  onSubmit,
  query,
}: CaseLawSearchProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const locale = useI18nStore((state) => state.loadedLang);
  const refine = useMutation({
    mutationFn: async (asked: { country: string; entry: string }) =>
      await refineCaseLawQuery({
        country: fromCaseLawCountryParam(asked.country),
        locale,
        query: asked.entry,
      }),
    // The box stays editable while the model answers. A rewrite of an entry
    // the reader has since changed, or of another jurisdiction, is dropped
    // rather than written over what they typed.
    onSuccess: (refined, asked) => {
      if (asked.entry !== query.trim() || asked.country !== country) {
        return;
      }
      onRefined(refined.query);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
    },
  });

  return (
    <PublicLawSearch
      askPrompt={(entry) =>
        t("caseLaw.searchAskPrompt", {
          country: caseLawCountryName(format, fromCaseLawCountryParam(country)),
          query: entry,
        })
      }
      maxLength={maxLength}
      onQueryChange={onQueryChange}
      onSubmit={onSubmit}
      placeholder={t("caseLaw.searchPlaceholder")}
      query={query}
      refine={{
        isPending: refine.isPending,
        onRefine: () => refine.mutate({ country, entry: query.trim() }),
      }}
      searchLabel={t("caseLaw.searchLabel")}
    />
  );
};

/**
 * A corpus country as a reader names it. One helper, because the search box,
 * the top-bar menu and the home all have to say the same country the same
 * way.
 */
export const caseLawCountryName = (
  format: ReturnType<typeof useFormatter>,
  code: string,
): string => {
  const region = caseLawCountryRegion(code);
  return region === null
    ? code
    : format.displayName(region, { type: "region" });
};
