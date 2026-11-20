import { useCallback, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { SettledQueryViewFeedback } from "@/components/query-view-feedback";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  clauseCategoriesOptions,
  clausesOptions,
  knowledgeKeys,
} from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";
import { ClauseDetailView } from "@/routes/knowledge/-components/clause-detail";
import { ClauseFormDialog } from "@/routes/knowledge/-components/clause-form-dialog";
import { ClauseList } from "@/routes/knowledge/-components/clause-list";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";
import { ClausesPending } from "@/routes/knowledge/-member/clauses.pending";

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

type ClauseItem = ClauseListData["items"][number];

// ── View discriminated union ─────────────────────────

type View = { kind: "list" } | { kind: "detail"; clauseId: string };

function RouteComponent() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
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

  const categoriesDataQuery = useQuery(
    clauseCategoriesOptions(activeOrganizationId),
  );
  const categoriesDataView = queryView(categoriesDataQuery);
  useQueryViewError(categoriesDataView, "RouteComponent:query");
  const categoriesData =
    categoriesDataView.type === "items" ? categoriesDataView.items : undefined;
  const {
    data: clausesData,
    isLoading,
    isError,
  } = useQuery({
    ...clausesOptions(activeOrganizationId, {
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
    clausesData && "items" in clausesData ? clausesData.items : [];

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
      const { data, error } = response;

      // Discard if aborted (filter changed mid-flight).
      if (controller.signal.aborted) {
        return;
      }

      if (error) {
        notifyUserError(error, t("clauses.loadFailed"), {
          description: userErrorMessage(error, t("common.unexpectedError")),
        });
        return;
      }

      if (data instanceof Response) {
        return;
      }

      setExtraClauses((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
    } finally {
      if (!controller.signal.aborted) {
        setLoadingMore(false);
      }
    }
    // oxlint-disable-next-line react/memo-dependencies -- clauses.tsx bails out of the React Compiler (memoization baseline), so this manual closure must capture the current selectedCategory/searchQuery/t at call time; removing them would paginate the wrong category on a stale closure
  }, [currentNextCursor, selectedCategory, searchQuery, t]);

  // ── Refresh ────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    setExtraClauses([]);
    setNextCursor(undefined);
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.clauses.all(activeOrganizationId),
      }),
      "knowledge-clauses.invalidate-clauses",
    );
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.clauseCategories.all(activeOrganizationId),
      }),
      "knowledge-clauses.invalidate-categories",
    );
  }, [queryClient, activeOrganizationId]);

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
        organizationId={activeOrganizationId}
        onBack={handleBackToList}
        onDeleted={handleBackToList}
      />
    );
  }

  if (isLoading) {
    return <ClausesPending />;
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
      <SettledQueryViewFeedback view={categoriesDataView} />
      <ClauseList
        categories={categories}
        clauses={clauses}
        loading={loadingMore}
        nextCursor={currentNextCursor}
        onCategoriesChanged={() => {
          detached(
            queryClient.invalidateQueries({
              queryKey:
                knowledgeKeys.clauseCategories.all(activeOrganizationId),
            }),
            "knowledge-clauses.categories-changed",
          );
        }}
        onCategorySelect={handleCategorySelect}
        onClauseSelect={(clause) =>
          setView({
            kind: "detail",
            clauseId: clause.id,
          })
        }
        onLoadMore={() => {
          detached(handleLoadMore(), "knowledge-clauses.load-more");
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

/** The organization's clause library, or one clause open. */
export function ClausesPage() {
  return (
    <KnowledgeMemberOnly pending={<ClausesPending />}>
      {(organizationId) => <RouteComponent key={organizationId} />}
    </KnowledgeMemberOnly>
  );
}
