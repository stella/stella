import { useCallback, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import {
  StatuteListRow,
  StatuteListRowSkeleton,
} from "@/features/statutes/components/statute-list-row";
import { StatuteSearch } from "@/features/statutes/components/statute-search";
import { statutesInfiniteOptions } from "@/features/statutes/queries/statutes";
import type { StatuteListFilters } from "@/features/statutes/queries/statutes";
import {
  parseStatuteQuery,
  type StatuteQueryIntent,
} from "@/features/statutes/statute-query-intent";
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
  isStatuteCountry,
  toStatuteCountrySegment,
} from "@/lib/statute-route";

/** What the route accepts in `q`, and therefore what the field may hold. */
const MAX_QUERY_LENGTH = 256;

// Stable keys so loading rows never fall back to array-index keys.
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

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

/**
 * What an entry asks for in this jurisdiction. A country the grammar does
 * not know reads every entry as text.
 */
const readIntent = (
  country: string,
  q: string | undefined,
): StatuteQueryIntent => {
  if (q === undefined) {
    return { type: "empty" };
  }
  return isStatuteCountry(country)
    ? parseStatuteQuery(country, q)
    : { type: "text", text: q };
};

const createStatuteFilters = (
  country: string,
  intent: StatuteQueryIntent,
): StatuteListFilters => {
  const scope = { country: country.toUpperCase() };
  switch (intent.type) {
    case "empty":
      return scope;
    case "act":
      return {
        ...scope,
        number: `${intent.number}/${intent.year}`,
        ...(intent.collection === null
          ? {}
          : { collection: intent.collection }),
      };
    case "text":
      return { ...scope, query: intent.text };
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
};

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
      statutesInfiniteOptions(
        createStatuteFilters(
          params.country,
          readIntent(params.country, deps.q),
        ),
      ),
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

/**
 * What the list under the box is: the recency shelf when nothing was typed,
 * the alias the entry was read as, nothing for a plain search or a number.
 */
function ListHeading({ intent }: { intent: StatuteQueryIntent }) {
  const t = useTranslations();

  if (intent.type === "empty") {
    return <ListHeadingText>{t("statutes.recentlyAmended")}</ListHeadingText>;
  }
  if (intent.type === "act" && intent.label !== null) {
    return (
      <ListHeadingText>
        {t("statutes.resolvedAlias", { label: intent.label })}
      </ListHeadingText>
    );
  }
  return null;
}

function ListHeadingText({ children }: { children: string }) {
  return (
    <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {children}
    </h2>
  );
}

function PublicStatutesIndexPending() {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-lg font-semibold">{t("statutes.title")}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-36 rounded-md" />
        <Skeleton className="h-9 w-full max-w-md flex-1 rounded-md" />
      </div>
      <Skeleton className="h-4 w-40" />
      <ul className="flex flex-col gap-2">
        {SKELETON_ROW_KEYS.map((key) => (
          <li key={key}>
            <StatuteListRowSkeleton />
          </li>
        ))}
      </ul>
    </main>
  );
}

function PublicStatutesIndex() {
  const t = useTranslations();
  const queryClient = useQueryClient();
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

  const intent = readIntent(country, search.q);
  const filters = createStatuteFilters(country, intent);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      ...statutesInfiniteOptions(filters),
      placeholderData: keepPreviousData,
    });

  const statutes = data ? data.pages.flatMap((page) => page.items) : [];

  // Enter on an act reference opens the act when exactly one work answers
  // to it. Several (the same number in two collections) stay listed, so the
  // reader picks; nothing is guessed. The field's value is read directly:
  // the debounced URL write may still be pending.
  const openSingleMatch = () => {
    const submitted = readIntent(country, queryInput.trim() || undefined);
    if (submitted.type !== "act") {
      return;
    }
    writeQuery.flush();
    detached(
      (async () => {
        const pages = await ensureRouteInfiniteQueryData(
          queryClient,
          statutesInfiniteOptions(createStatuteFilters(country, submitted)),
        );
        const firstPage = pages.pages.at(0);
        if (firstPage?.items.length !== 1) {
          return;
        }
        const only = firstPage.items.at(0);
        if (only === undefined) {
          return;
        }
        await navigate({
          params: {
            country: toStatuteCountrySegment(only.country),
            documentId: only.id,
          },
          search:
            submitted.provision === null ? {} : { jump: submitted.provision },
          to: "/law/$country/statutes/$documentId",
        });
      })(),
      "statutes.open-match",
    );
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-lg font-semibold">{t("statutes.title")}</h1>
      <StatuteSearch
        country={country}
        maxLength={MAX_QUERY_LENGTH}
        onCountryChange={(nextCountry) => {
          detached(
            navigate({
              params: { country: nextCountry },
              search: (previous) => previous,
              to: "/law/$country/statutes",
            }),
            "statutes.switch-country",
          );
        }}
        onQueryChange={handleQueryChange}
        onSubmit={openSingleMatch}
        query={queryInput}
      />

      <ListHeading intent={intent} />

      {statutes.length === 0 && !isLoading ? (
        <p className="text-muted-foreground text-sm">
          {t("statutes.emptyState")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {isLoading
            ? SKELETON_ROW_KEYS.map((key) => (
                <li key={key}>
                  <StatuteListRowSkeleton />
                </li>
              ))
            : statutes.map((statute) => (
                <li key={statute.id}>
                  <StatuteListRow statute={statute} />
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
