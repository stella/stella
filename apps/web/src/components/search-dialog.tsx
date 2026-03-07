import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  FileTextIcon,
  FolderIcon,
  LoaderIcon,
  MessageSquareIcon,
  SearchIcon,
  SquareCheckIcon,
  XIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import type { EntityKind } from "@stella/api/types";
import { Button } from "@stella/ui/components/button";
import { Checkbox } from "@stella/ui/components/checkbox";
import { Dialog, DialogPopup } from "@stella/ui/components/dialog";
import { Input } from "@stella/ui/components/input";
import { Skeleton } from "@stella/ui/components/skeleton";
import { cn } from "@stella/ui/lib/utils";

import { searchInfiniteOptions } from "@/lib/search";

const DEBOUNCE_MS = 300;

const KIND_ICONS: Record<EntityKind, typeof FileTextIcon> = {
  document: FileTextIcon,
  folder: FolderIcon,
  task: SquareCheckIcon,
  message: MessageSquareIcon,
};

const KIND_TRANSLATION_KEYS = {
  document: "search.kinds.document",
  folder: "search.kinds.folder",
  task: "search.kinds.task",
  message: "search.kinds.message",
} as const satisfies Record<EntityKind, `search.kinds.${EntityKind}`>;

const isEntityKind = (value: string): value is EntityKind =>
  value in KIND_TRANSLATION_KEYS;

type SearchFilters = {
  workspaceId?: string;
  kinds?: EntityKind[];
};

type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialWorkspaceId?: string;
};

export const SearchDialog = ({
  open,
  onOpenChange,
  initialWorkspaceId,
}: SearchDialogProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const resultsRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>({
    workspaceId: initialWorkspaceId,
  });
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const debouncedSetQuery = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value);
    setSelectedIndex(-1);
  }, DEBOUNCE_MS);

  const {
    data,
    isLoading,
    isFetching,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    searchInfiniteOptions({
      query: debouncedQuery,
      workspaceId: filters.workspaceId,
      kinds: filters.kinds,
    }),
  );

  const allHits = data?.pages.flatMap((page) => page.hits) ?? [];
  const latestPage = data?.pages.at(-1);
  const facets = latestPage?.facets;
  const totalCount = latestPage?.totalCount ?? 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when selection changes
  useEffect(() => {
    const el = resultsRef.current?.querySelector("[data-selected]");
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);
      debouncedSetQuery(value);
    },
    [debouncedSetQuery],
  );

  const toggleKindFilter = useCallback((kind: EntityKind) => {
    setFilters((prev) => {
      const current = prev.kinds ?? [];
      const next = current.includes(kind)
        ? current.filter((k) => k !== kind)
        : [...current, kind];
      return {
        ...prev,
        kinds: next.length > 0 ? next : undefined,
      };
    });
    setSelectedIndex(-1);
  }, []);

  const setWorkspaceFilter = useCallback((workspaceId: string | undefined) => {
    setFilters((prev) => ({
      ...prev,
      workspaceId,
    }));
    setSelectedIndex(-1);
  }, []);

  const removeKindFilter = useCallback((kind: EntityKind) => {
    setFilters((prev) => {
      const next = (prev.kinds ?? []).filter((k) => k !== kind);
      return {
        ...prev,
        kinds: next.length > 0 ? next : undefined,
      };
    });
    setSelectedIndex(-1);
  }, []);

  const handleResultClick = useCallback(
    async (workspaceId: string) => {
      onOpenChange(false);
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId },
      });
    },
    [navigate, onOpenChange],
  );

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, allHits.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Enter" && selectedIndex >= 0) {
        e.preventDefault();
        const hit = allHits[selectedIndex];
        if (hit) {
          await handleResultClick(hit.workspaceId);
        }
      }
    },
    [allHits, selectedIndex, handleResultClick],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen);
      if (!nextOpen) {
        setQuery("");
        setDebouncedQuery("");
        setSelectedIndex(-1);
        setFilters({
          workspaceId: initialWorkspaceId,
        });
      }
    },
    [onOpenChange, initialWorkspaceId],
  );

  const hasResults = allHits.length > 0;
  const hasQuery = debouncedQuery.length > 0;
  const activeFilterCount =
    (filters.kinds?.length ?? 0) + (filters.workspaceId ? 1 : 0);

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup className="max-w-2xl" showCloseButton={false}>
        {/* Search input */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <SearchIcon className="size-5 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            className="flex-1 border-0 bg-transparent text-sm shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0"
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            placeholder={t("search.placeholder")}
            value={query}
          />
          {isFetching && !isFetchingNextPage && (
            <LoaderIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
            {t("search.escKey")}
          </kbd>
        </div>

        {/* Active filter chips */}
        {activeFilterCount > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
            {filters.workspaceId && (
              <FilterChip
                label={
                  facets?.workspace.find((w) => w.value === filters.workspaceId)
                    ?.label ?? filters.workspaceId
                }
                onRemove={() => setWorkspaceFilter(undefined)}
                type={t("search.facets.workspace")}
              />
            )}
            {filters.kinds?.map((kind) => (
              <FilterChip
                key={kind}
                label={t(KIND_TRANSLATION_KEYS[kind])}
                onRemove={() => removeKindFilter(kind)}
                type={t("search.facets.kind")}
              />
            ))}
          </div>
        )}

        {/* Content area */}
        <div className="flex max-h-[min(60vh,480px)] min-h-[200px]">
          {/* Facets sidebar */}
          {hasQuery && facets && (
            <div className="w-48 shrink-0 overflow-y-auto border-r px-3 py-3">
              {facets.kind.length > 0 && (
                <FacetGroup
                  buckets={facets.kind.map((bucket) => ({
                    ...bucket,
                    label: isEntityKind(bucket.value)
                      ? t(KIND_TRANSLATION_KEYS[bucket.value])
                      : bucket.value,
                  }))}
                  onChange={(value) => {
                    if (isEntityKind(value)) {
                      toggleKindFilter(value);
                    }
                  }}
                  selected={filters.kinds ?? []}
                  title={t("search.facets.kind")}
                />
              )}

              {facets.workspace.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {t("search.facets.workspace")}
                  </p>
                  <div className="space-y-0.5">
                    {facets.workspace.map((bucket) => (
                      <Button
                        className={cn(
                          "h-auto w-full justify-between px-2 py-1 text-xs",
                          filters.workspaceId === bucket.value &&
                            "bg-muted font-medium",
                        )}
                        key={bucket.value}
                        onClick={() =>
                          setWorkspaceFilter(
                            filters.workspaceId === bucket.value
                              ? undefined
                              : bucket.value,
                          )
                        }
                        size="sm"
                        variant="ghost"
                      >
                        <span className="truncate">
                          {bucket.label ?? bucket.value}
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          {bucket.count}
                        </span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Results */}
          <div className="flex-1 overflow-y-auto" ref={resultsRef}>
            {!hasQuery && (
              <div className="flex h-full items-center justify-center px-4 py-8">
                <p className="text-sm text-muted-foreground">
                  {t("search.emptyState")}
                </p>
              </div>
            )}

            {hasQuery && isLoading && (
              <div className="space-y-3 px-4 py-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list never reorders
                  <div className="space-y-2" key={`skeleton-${i}`}>
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ))}
              </div>
            )}

            {hasQuery && !isLoading && !hasResults && (
              <div className="flex h-full items-center justify-center px-4 py-8">
                <p className="text-sm text-muted-foreground">
                  {t("search.noResults", {
                    query: debouncedQuery,
                  })}
                </p>
              </div>
            )}

            {hasResults && (
              <div className="px-2 py-2">
                <p className="px-2 pb-2 text-xs text-muted-foreground">
                  {t("search.resultCount", {
                    count: totalCount,
                  })}
                </p>
                {allHits.map((hit, index) => (
                  <SearchResultItem
                    hit={hit}
                    isSelected={index === selectedIndex}
                    key={hit.entityId}
                    onClick={handleResultClick}
                  />
                ))}
                {hasNextPage && (
                  <div className="px-2 pt-2">
                    <Button
                      className="w-full"
                      disabled={isFetchingNextPage}
                      onClick={() => fetchNextPage()}
                      size="sm"
                      variant="ghost"
                    >
                      {isFetchingNextPage && (
                        <LoaderIcon className="size-3 animate-spin" />
                      )}
                      {t("search.loadMore")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
};

type FilterChipProps = {
  type: string;
  label: string;
  onRemove: () => void;
};

const FilterChip = ({ type, label, onRemove }: FilterChipProps) => {
  const t = useTranslations();
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs">
      <span className="text-muted-foreground">
        {t("search.filterLabel", { type })}
      </span>
      <span className="font-medium">{label}</span>
      <Button
        aria-label={`Remove ${type}: ${label}`}
        className="ml-0.5 size-4 rounded-full"
        onClick={onRemove}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon className="size-3" />
      </Button>
    </span>
  );
};

type FacetGroupProps = {
  title: string;
  buckets: Array<{
    value: string;
    label?: string;
    count: number;
  }>;
  selected: string[];
  onChange: (value: string) => void;
};

const FacetGroup = ({
  title,
  buckets,
  selected,
  onChange,
}: FacetGroupProps) => (
  <div>
    <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
    <div className="space-y-0.5">
      {buckets.map((bucket) => (
        <Button
          className="h-auto w-full justify-start gap-2 px-2 py-1 text-xs"
          key={bucket.value}
          onClick={() => onChange(bucket.value)}
          size="sm"
          variant="ghost"
        >
          <Checkbox checked={selected.includes(bucket.value)} tabIndex={-1} />
          <span className="flex-1 truncate text-left">
            {bucket.label ?? bucket.value}
          </span>
          <span className="text-muted-foreground">{bucket.count}</span>
        </Button>
      ))}
    </div>
  </div>
);

type SearchResultItemProps = {
  hit: {
    entityId: string;
    workspaceId: string;
    workspaceName: string;
    kind: EntityKind;
    title: string;
    headline: string | null;
    updatedAt: string;
  };
  isSelected?: boolean;
  onClick: (workspaceId: string) => void;
};

const SearchResultItem = ({
  hit,
  isSelected,
  onClick,
}: SearchResultItemProps) => {
  const t = useTranslations();
  const Icon = KIND_ICONS[hit.kind] ?? FileTextIcon;
  const date = new Date(hit.updatedAt);
  const formatted = date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });

  return (
    <Button
      className={cn(
        "h-auto w-full items-start justify-start gap-3 px-2 py-2 text-left whitespace-normal sm:h-auto",
        isSelected && "bg-accent",
      )}
      data-selected={isSelected || undefined}
      // TODO: navigate to entity detail page once routes exist
      onClick={() => onClick(hit.workspaceId)}
      variant="ghost"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {hit.title || hit.entityId}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {t("search.metaSeparator", {
            workspace: hit.workspaceName,
            time: formatted,
          })}
        </p>
        {hit.headline && (
          <p
            className="mt-0.5 line-clamp-2 text-xs font-normal text-muted-foreground [&_mark]:bg-highlight [&_mark]:font-medium [&_mark]:text-highlight-foreground"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: headline is escaped server-side (escapeAndHighlight) and only contains <mark> tags
            dangerouslySetInnerHTML={{
              __html: hit.headline,
            }}
          />
        )}
      </div>
    </Button>
  );
};
