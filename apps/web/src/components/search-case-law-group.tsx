import { useId } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Loader } from "@stll/ui/loader";
import { cn } from "@stll/ui/utils";

import type { GlobalSearchHit } from "@/lib/api-contract";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { searchInfiniteOptions } from "@/lib/search";
import type { SearchParams } from "@/lib/search";

type SearchCaseLawGroupProps = {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  query: string;
  debouncedQuery: string;
  organizationId: string;
  userId: string;
  searchFilters: Pick<
    SearchParams,
    | "workspaceIds"
    | "kinds"
    | "editedByUserIds"
    | "mimeTypes"
    | "updatedFrom"
    | "updatedTo"
  >;
  selectedHitId?: string | undefined;
  onPreview: (hit: GlobalSearchHit) => void;
  onOpen: (hit: GlobalSearchHit) => void;
};

export const SearchCaseLawGroup = ({
  expanded,
  onExpandedChange,
  ...resultsProps
}: SearchCaseLawGroupProps) => {
  const t = useTranslations();
  const contentId = useId();

  return (
    <section className="border-t px-2 py-1">
      <Button
        aria-controls={contentId}
        aria-expanded={expanded}
        className="min-h-11 w-full justify-start gap-2 px-2 text-start"
        onClick={() => onExpandedChange(!expanded)}
        variant="ghost"
      >
        <DirectionalIcon
          className={cn("size-4", expanded && "rotate-90")}
          flip={!expanded}
          icon={ChevronRightIcon}
        />
        {t("common.caseLaw")}
      </Button>
      <div id={contentId}>
        {expanded && <SearchCaseLawResults {...resultsProps} />}
      </div>
    </section>
  );
};

const SearchCaseLawResults = ({
  query,
  debouncedQuery,
  organizationId,
  userId,
  searchFilters,
  selectedHitId,
  onPreview,
  onOpen,
}: Omit<SearchCaseLawGroupProps, "expanded" | "onExpandedChange">) => {
  const t = useTranslations();
  const ready = query.trim().length > 0 && query === debouncedQuery;
  const result = useInfiniteQuery(
    searchInfiniteOptions({
      enabled: ready,
      organizationId,
      userId,
      query: debouncedQuery,
      ...searchFilters,
      types: ["case-law"],
      limit: 10,
    }),
  );
  const hits =
    ready && !result.isPlaceholderData
      ? (result.data?.pages.flatMap((page) => page.hits) ?? [])
      : [];

  return (
    <div className="space-y-1 px-2 pb-2">
      {(!ready || result.isLoading || result.isPlaceholderData) && (
        <Loader label={t("common.loading")} size="sm" />
      )}
      {ready && result.isError && (
        <div className="space-y-2 py-2" role="alert">
          <p className="text-muted-foreground text-sm">
            {userErrorFromThrown(result.error, t("common.somethingWentWrong"))}
          </p>
          <Button
            className="min-h-11"
            onClick={() =>
              detached(
                result.isFetchNextPageError
                  ? result.fetchNextPage()
                  : result.refetch(),
                "search-case-law.retry",
              )
            }
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {ready &&
        result.isSuccess &&
        !result.isPlaceholderData &&
        hits.length === 0 && (
          <p className="text-muted-foreground py-2 text-sm">
            {t("common.noResults")}
          </p>
        )}
      {hits.map((hit) => (
        <div className="flex min-w-0 items-start gap-1" key={hit.id}>
          <button
            aria-pressed={selectedHitId === hit.id}
            className="hover:bg-muted focus-visible:ring-ring aria-pressed:bg-muted min-h-11 min-w-0 flex-1 rounded-md px-2 py-2 text-start outline-none focus-visible:ring-2"
            onClick={() => onPreview(hit)}
            onFocus={() => onPreview(hit)}
            type="button"
          >
            <span className="block truncate text-sm font-medium" dir="auto">
              {hit.title || hit.id}
            </span>
            {hit.headline && (
              <span
                className="text-muted-foreground [&_mark]:bg-highlight [&_mark]:text-highlight-foreground mt-0.5 line-clamp-2 text-xs [&_mark]:font-medium"
                dangerouslySetInnerHTML={{
                  // safe-html: server-escaped + <mark>-highlighted by global search mappers
                  __html: hit.headline,
                }}
                dir="auto"
              />
            )}
          </button>
          <Button
            aria-label={t("common.open")}
            className="min-h-11 min-w-11 shrink-0"
            onClick={() => onOpen(hit)}
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
          </Button>
        </div>
      ))}
      {ready &&
        !result.isPlaceholderData &&
        result.hasNextPage &&
        !result.isFetchNextPageError && (
          <Button
            className="min-h-11"
            disabled={result.isFetchingNextPage}
            onClick={() =>
              detached(result.fetchNextPage(), "search-case-law.load-more")
            }
            variant="ghost"
          >
            {t(
              result.isFetchingNextPage ? "common.loading" : "common.loadMore",
            )}
          </Button>
        )}
    </div>
  );
};
