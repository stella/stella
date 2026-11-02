import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { StatuteFilterPopover } from "@/features/statutes/components/statute-filter-popover";
import { StatuteSearch } from "@/features/statutes/components/statute-search";
import {
  statuteFacetsOptions,
  statuteKeys,
} from "@/features/statutes/queries/statutes";
import {
  activeStatuteFilterCount,
  withStatuteFilter,
} from "@/features/statutes/statute-filters.logic";
import {
  changeStatutesIndexQuery,
  STATUTE_MAX_QUERY_LENGTH,
} from "@/features/statutes/statute-index-search.logic";
import type { StatutesIndexSearch } from "@/features/statutes/statute-index-search.logic";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { PublicLawListFailure } from "@/routes/law/-components/public-law-list-failure";

/** Keeps statute search and filters available after a route-level failure. */
export const PublicStatutesIndexError = ({ error }: ErrorComponentProps) => {
  const t = useTranslations();
  const params = useParams({
    from: "/law/$country/statutes/",
    select: ({ country }) => ({ country }),
  });
  const search = useSearch({
    from: "/law/$country/statutes/",
    select: (value) => value,
  });
  const navigate = useNavigate({ from: "/law/$country/statutes/" });
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(search.q ?? "");
  const facets = useQuery(statuteFacetsOptions(params.country.toUpperCase()));
  const facetsView = queryView(facets);
  useQueryViewError(facetsView, "PublicStatutesIndexError.facets:failure");
  const recoverSearch = (next: StatutesIndexSearch) => {
    detached(
      navigate({ search: { ...next, page: undefined } }),
      "statutes.error-navigate",
    );
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <h1 className="sr-only">{t("statutes.title")}</h1>
      <StatuteSearch
        country={params.country}
        maxLength={STATUTE_MAX_QUERY_LENGTH}
        onQueryChange={setQuery}
        onSubmit={() =>
          recoverSearch(
            changeStatutesIndexQuery({
              country: params.country,
              previous: search,
              query,
            }),
          )
        }
        query={query}
      />
      <QueryViewFeedback view={facetsView} />
      <StatuteFilterPopover
        activeFilterCount={activeStatuteFilterCount(search)}
        onSelect={(key, value) =>
          recoverSearch(
            changeStatutesIndexQuery({
              country: params.country,
              previous: withStatuteFilter(search, key, value),
              query,
            }),
          )
        }
        selection={{
          type: search.type,
          validity: search.validity,
          year: search.year,
        }}
        types={facetsView.type === "items" ? facetsView.items.documentType : []}
      />
      <PublicLawListFailure
        error={error}
        reset={() => {
          detached(
            (async () => {
              await queryClient.resetQueries({
                queryKey: statuteKeys.all,
                predicate: ({ state }) => state.status === "error",
              });
              await navigate({ search, replace: true });
            })(),
            "statutes.error-retry",
          );
        }}
      />
    </main>
  );
};
