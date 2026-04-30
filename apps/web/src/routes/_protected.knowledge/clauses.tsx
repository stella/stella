import { useCallback, useRef, useState } from "react";

import { toastManager } from "@stll/ui/components/toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { ClauseDetailView } from "@/routes/_protected.knowledge/-components/clause-detail";
import { ClauseFormDialog } from "@/routes/_protected.knowledge/-components/clause-form-dialog";
import { ClauseList } from "@/routes/_protected.knowledge/-components/clause-list";
import {
  clauseCategoriesOptions,
  clausesOptions,
  knowledgeKeys,
} from "@/routes/_protected.knowledge/-queries";

// ── Type extraction ──────────────────────────────────

type CatListResponse = Awaited<
  ReturnType<(typeof api)["clause-categories"]["get"]>
>;

type CatListData = Exclude<
  NonNullable<Extract<CatListResponse, { data: unknown }>["data"]>,
  Response
>;

type CategoryItem = CatListData["categories"][number];

type ClauseListResponse = Awaited<ReturnType<typeof api.clauses.get>>;

type ClauseListData = Exclude<
  NonNullable<Extract<ClauseListResponse, { data: unknown }>["data"]>,
  Response
>;

type ClauseItem = ClauseListData["clauses"][number];

// ── View discriminated union ─────────────────────────

type View = { kind: "list" } | { kind: "detail"; clauseId: string };

// ── Route ────────────────────────────────────────────

export const Route = createFileRoute("/_protected/knowledge/clauses")({
  component: RouteComponent,
});

function RouteComponent() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ kind: "list" });
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  // Extra clauses from cursor-based pagination.
  // nextCursor uses three-state: undefined = "not yet loaded
  // extras" (fall back to initialNextCursor), string = "has more
  // pages", null = "reached the last page".
  const [extraClauses, setExtraClauses] = useState<ClauseItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  // Abort in-flight load-more requests when filters change.
  const loadMoreAbort = useRef<AbortController | null>(null);

  const { data: categoriesData } = useQuery(clauseCategoriesOptions());
  const {
    data: clausesData,
    isLoading,
    isError,
  } = useQuery({
    ...clausesOptions({
      categoryId: selectedCategory,
      search: searchQuery,
    }),
    // Disable background refetch: the initial page can desync
    // with manually-loaded extraClauses from cursor pagination.
    // Manual refresh via handleRefresh is the intended path.
    refetchOnWindowFocus: false,
  });

  const categories: CategoryItem[] =
    categoriesData && "categories" in categoriesData
      ? categoriesData.categories
      : [];

  const initialClauses: ClauseItem[] =
    clausesData && "clauses" in clausesData ? clausesData.clauses : [];

  const initialNextCursor =
    clausesData && "nextCursor" in clausesData ? clausesData.nextCursor : null;

  // Combine initial query results with cursor-loaded extras
  const clauses =
    extraClauses.length > 0
      ? [...initialClauses, ...extraClauses]
      : initialClauses;

  const currentNextCursor =
    nextCursor === undefined ? initialNextCursor : nextCursor;

  // ── Category change ────────────────────────────────

  const handleCategorySelect = useCallback((categoryId: string | null) => {
    loadMoreAbort.current?.abort();
    setLoadingMore(false);
    setSelectedCategory(categoryId);
    setExtraClauses([]);
    setNextCursor(undefined);
  }, []);

  // ── Search ─────────────────────────────────────────

  const handleSearch = useCallback((q: string) => {
    loadMoreAbort.current?.abort();
    setLoadingMore(false);
    setSearchQuery(q);
    setExtraClauses([]);
    setNextCursor(undefined);
  }, []);

  // ── Load more (cursor pagination) ─────────────────

  const handleLoadMore = useCallback(async () => {
    const cursor = currentNextCursor;
    if (!cursor) {
      return;
    }

    loadMoreAbort.current?.abort();
    const controller = new AbortController();
    loadMoreAbort.current = controller;

    setLoadingMore(true);

    try {
      const query: {
        categoryId?: SafeId<"clauseCategory">;
        uncategorized?: boolean;
        q?: string;
        cursor: string;
        limit: number;
      } = { cursor, limit: 50 };

      if (selectedCategory === "uncategorized") {
        query.uncategorized = true;
      } else if (selectedCategory) {
        query.categoryId = toSafeId<"clauseCategory">(selectedCategory);
      }

      if (searchQuery) {
        query.q = searchQuery;
      }

      const response = await api.clauses.get({
        query,
        fetch: { signal: controller.signal },
      });

      // Discard if aborted (filter changed mid-flight).
      if (controller.signal.aborted) {
        return;
      }

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("clauses.loadFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      const { data } = response;
      if (data instanceof Response) {
        return;
      }

      setExtraClauses((prev) => [...prev, ...data.clauses]);
      setNextCursor(data.nextCursor);
    } finally {
      if (!controller.signal.aborted) {
        setLoadingMore(false);
      }
    }
  }, [currentNextCursor, selectedCategory, searchQuery, t]);

  // ── Refresh ────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    setExtraClauses([]);
    setNextCursor(undefined);
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.clauses.all,
      })
      .catch(() => {
        /* fire-and-forget */
      });
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.clauseCategories.all,
      })
      .catch(() => {
        /* fire-and-forget */
      });
  }, [queryClient]);

  // ── Back to list ───────────────────────────────────

  const handleBackToList = useCallback(() => {
    setView({ kind: "list" });
    if (searchQuery) {
      setSearchQuery("");
    }
    handleRefresh();
  }, [searchQuery, handleRefresh]);

  // ── Render ─────────────────────────────────────────

  if (view.kind === "detail") {
    return (
      <ClauseDetailView
        categories={categories}
        clauseId={view.clauseId}
        onBack={handleBackToList}
        onDeleted={handleBackToList}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("clauses.loading")}</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("clauses.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <>
      <ClauseList
        categories={categories}
        clauses={clauses}
        loading={loadingMore}
        nextCursor={currentNextCursor}
        onCategoriesChanged={() => {
          queryClient
            .invalidateQueries({
              queryKey: knowledgeKeys.clauseCategories.all,
            })
            .catch(() => {
              /* fire-and-forget */
            });
        }}
        onCategorySelect={handleCategorySelect}
        onClauseSelect={(clause) =>
          setView({
            kind: "detail",
            clauseId: clause.id,
          })
        }
        onLoadMore={() => {
          handleLoadMore().catch(() => {
            /* fire-and-forget */
          });
        }}
        onNewClause={() => setCreateOpen(true)}
        onRefresh={handleRefresh}
        onSearch={handleSearch}
        selectedCategoryId={selectedCategory}
      />

      <ClauseFormDialog
        categories={categories}
        onOpenChange={setCreateOpen}
        onSaved={handleRefresh}
        open={createOpen}
      />
    </>
  );
}
