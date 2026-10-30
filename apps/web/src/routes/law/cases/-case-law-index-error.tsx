import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";

import { PublicLawSearch } from "@/components/public-law-search";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import {
  activeCaseLawFilterCount,
  decisionDateRange,
  validDecisionDate,
  withQuery,
} from "@/features/case-law/case-law-index-search.logic";
import { useCaseLawAskScope } from "@/features/case-law/components/case-law-search";
import { DecisionFilterPopover } from "@/features/case-law/components/decision-filter-popover";
import { decisionFilterFacets } from "@/features/case-law/decision-filter-facets";
import {
  caseLawDecisionKeys,
  decisionFacetsOptions,
} from "@/features/case-law/queries/decisions";
import { getMessageLocale } from "@/i18n/i18n-store";
import { resolveCaseLawRouteCountry } from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { PublicLawListFailure } from "@/routes/law/-components/public-law-list-failure";

/** The route boundary reads only URL controls and independent corpus facets. */
export const PublicCaseLawIndexError = (props: ErrorComponentProps) => {
  const t = useTranslations();
  const search = useSearch({ from: "/law/cases/", select: (value) => value });
  const navigate = useNavigate({ from: "/law/cases/" });
  const queryClient = useQueryClient();
  const country = resolveCaseLawRouteCountry({
    country: search.country,
    locale: getMessageLocale(),
  });
  const askScope = useCaseLawAskScope(country ?? "");
  const [query, setQuery] = useState(search.q ?? "");
  const facetsQuery = useQuery({
    ...decisionFacetsOptions(country ?? ""),
    enabled: country !== null,
  });
  const facetsView = queryView(facetsQuery);
  useQueryViewError(facetsView, "PublicCaseLawIndexError.facets:failure");
  const facets = decisionFilterFacets({
    browse:
      facetsView.type === "items"
        ? facetsView.items
        : {
            country: [],
            court: [],
            year: [],
          },
    search: null,
  });
  const recoverSearch = (next: typeof search) => {
    detached(
      navigate({ search: { ...next, page: undefined } }),
      "cases.error-navigate",
    );
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <h1 className="sr-only">{t("common.caseLaw")}</h1>
      <PublicLawSearch
        askScope={askScope}
        maxLength={SEARCH_QUERY_MAX_LENGTH}
        onQueryChange={setQuery}
        onSubmit={() => recoverSearch(withQuery(search, query))}
        placeholder={t("caseLaw.searchPlaceholder")}
        query={query}
        searchLabel={t("caseLaw.searchLabel")}
      />
      <QueryViewFeedback view={facetsView} />
      <DecisionFilterPopover
        activeFilterCount={activeCaseLawFilterCount(search)}
        dateRange={decisionDateRange(search)}
        facets={facets}
        onDateRangeChange={(range) =>
          recoverSearch({
            ...withQuery(search, query),
            from: validDecisionDate(range.from),
            to: validDecisionDate(range.to),
            year: undefined,
          })
        }
        onSelect={(key, value) =>
          recoverSearch({ ...withQuery(search, query), [key]: value })
        }
        selection={{
          court: search.court,
          lang: search.lang,
          sourceId: search.sourceId,
          type: search.type,
        }}
      />
      <PublicLawListFailure
        {...props}
        reset={() => {
          detached(
            (async () => {
              await queryClient.resetQueries({
                queryKey: caseLawDecisionKeys.all,
                predicate: ({ state }) => state.status === "error",
              });
              await navigate({ search, replace: true });
            })(),
            "cases.error-retry",
          );
        }}
      />
    </main>
  );
};
