import { useCallback, useState } from "react";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Skeleton } from "@stll/ui/skeleton";

import { StatuteStatusPill } from "@/features/statutes/components/statute-status-pill";
import { statutesInfiniteOptions } from "@/features/statutes/queries/statutes";
import type { StatuteListFilters } from "@/features/statutes/queries/statutes";
import {
  EM_DASH,
  formatValidityDate,
} from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import {
  createStatuteIndexPath,
  createStatutePath,
  toStatuteCountrySegment,
} from "@/lib/statute-route";

/** What the route accepts in `q`, and therefore what the field may hold. */
const MAX_QUERY_LENGTH = 256;

const searchSchema = v.object({
  q: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(MAX_QUERY_LENGTH),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  ),
});

type StatutesIndexSearch = v.InferOutput<typeof searchSchema>;

const createStatuteFilters = (
  country: string,
  { q }: StatutesIndexSearch,
): StatuteListFilters => ({
  country: country.toUpperCase(),
  ...(q ? { query: q } : {}),
});

const createStatutesIndexPath = (
  country: string,
  { q }: StatutesIndexSearch,
): `/law/${string}` => {
  const path = createStatuteIndexPath(country);

  return q ? `${path}?q=${encodeURIComponent(q)}` : path;
};

export const Route = createFileRoute("/law/$country/statutes/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps, params }) => {
    const pages = await ensureRouteInfiniteQueryData(
      queryClient,
      statutesInfiniteOptions(createStatuteFilters(params.country, deps)),
    );

    const firstPage = pages.pages.at(0);

    return { statutes: firstPage ? firstPage.items : [] };
  },
  head: ({ loaderData, match, params }) => {
    const title = pageTitle("statutes.title");
    const description =
      "Public database of consolidated statutes, indexable by act and version.";
    const path = createStatutesIndexPath(params.country, match.search);

    return createPublicLawHead({
      description,
      jsonLd: createLegalCollectionJsonLd({
        aboutName: "Statutes",
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        kind: "statutes",
        items: loaderData
          ? loaderData.statutes.map((statute) => ({
              name: statute.title,
              url: createPublicLawCanonicalUrl(
                createStatutePath({
                  country: statute.country,
                  documentId: statute.id,
                }),
              ),
            }))
          : [],
        name: title,
      }),
      path,
      title,
      type: "website",
    });
  },
  component: PublicStatutesIndex,
  pendingComponent: PublicStatutesIndexPending,
});

function PublicStatutesIndexPending() {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-lg font-semibold">{t("statutes.title")}</h1>
      <Skeleton className="h-9 w-full max-w-xs rounded-md" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full rounded-md" />
        <Skeleton className="h-14 w-full rounded-md" />
        <Skeleton className="h-14 w-full rounded-md" />
      </div>
    </main>
  );
}

function PublicStatutesIndex() {
  const t = useTranslations();
  const format = useFormatter();
  const country = Route.useParams({ select: (params) => params.country });
  const search = Route.useSearch({ select: ({ q }) => ({ q }) });
  const navigate = Route.useNavigate();

  const [queryInput, setQueryInput] = useState(search.q ?? "");
  // What the field last asked the URL to hold. A navigation that lands on
  // this value is the field's own write coming back, not somebody else's.
  const [requestedQuery, setRequestedQuery] = useState(search.q ?? "");
  const writeQuery = useDebouncedCallback((value: string) => {
    detached(
      navigate({
        replace: true,
        search: () => (value.trim() ? { q: value } : {}),
      }),
      "statutes.search-navigate",
    );
  }, 300);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQueryInput(value);
      setRequestedQuery(value.trim());
      writeQuery(value);
    },
    [writeQuery],
  );

  // Resync the field when the route query changes underneath it, e.g. the
  // navigation back to this list drops `q`. Adjust state during render (the
  // React-sanctioned pattern) instead of an effect so there is no extra
  // commit/paint cycle.
  const [syncedQuery, setSyncedQuery] = useState(search.q);
  if (syncedQuery !== search.q) {
    setSyncedQuery(search.q);

    if ((search.q ?? "") !== requestedQuery) {
      setQueryInput(search.q ?? "");
    }
  }

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      ...statutesInfiniteOptions(createStatuteFilters(country, search)),
      placeholderData: keepPreviousData,
    });

  const statutes = data ? data.pages.flatMap((page) => page.items) : [];

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-lg font-semibold">{t("statutes.title")}</h1>
      <Input
        aria-label={t("statutes.searchLabel")}
        className="max-w-xs"
        maxLength={MAX_QUERY_LENGTH}
        onChange={(event) => handleQueryChange(event.currentTarget.value)}
        placeholder={t("statutes.searchPlaceholder")}
        value={queryInput}
      />

      {statutes.length === 0 && !isLoading ? (
        <p className="text-muted-foreground text-sm">
          {t("statutes.emptyState")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {statutes.map((statute) => (
            <li key={statute.id}>
              <Link
                className="hover:bg-muted/50 block rounded-md border px-4 py-3 transition-colors"
                params={{
                  country: toStatuteCountrySegment(statute.country),
                  documentId: statute.id,
                }}
                to="/law/$country/statutes/$documentId"
              >
                <span className="text-foreground block font-medium">
                  {statute.title}
                </span>
                <span className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <span>{statute.eli}</span>
                  <StatuteStatusPill status={statute.status} />
                  <span>
                    {t("statutes.inForceSince", {
                      date:
                        formatValidityDate(statute.versionValidFrom, format) ??
                        formatValidityDate(statute.effectiveDate, format) ??
                        EM_DASH,
                    })}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hasNextPage && (
        <Button
          disabled={isFetchingNextPage}
          onClick={() => detached(fetchNextPage(), "statutes.load-more")}
          variant="outline"
        >
          {t("common.loadMore")}
        </Button>
      )}
    </main>
  );
}
