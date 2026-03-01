import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { ClauseDetailView } from "@/routes/_protected.knowledge/-components/clause-detail";
import { ClauseFormDialog } from "@/routes/_protected.knowledge/-components/clause-form-dialog";
import { ClauseList } from "@/routes/_protected.knowledge/-components/clause-list";

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
  const [view, setView] = useState<View>({ kind: "list" });
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [clauses, setClauses] = useState<ClauseItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // ── Fetch categories ───────────────────────────────

  const fetchCategories = useCallback(async () => {
    const response = await api["clause-categories"].get();

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

    setCategories(data.categories);
  }, [t]);

  // ── Fetch clauses ──────────────────────────────────

  const fetchClauses = useCallback(
    async (cursor?: string) => {
      setLoading(true);

      const query: {
        categoryId?: string;
        uncategorized?: boolean;
        cursor?: string;
        limit?: number;
      } = { limit: 50 };

      if (selectedCategory === "uncategorized") {
        query.uncategorized = true;
      } else if (selectedCategory) {
        query.categoryId = selectedCategory;
      }

      if (cursor) {
        query.cursor = cursor;
      }

      const response = await api.clauses.get({
        query,
      });

      setLoading(false);

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("clauses.loadFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        setLoaded(true);
        return;
      }

      const { data } = response;
      if (data instanceof Response) {
        setLoaded(true);
        return;
      }

      if (cursor) {
        setClauses((prev) => [...prev, ...data.clauses]);
      } else {
        setClauses(data.clauses);
      }
      setNextCursor(data.nextCursor);
      setLoaded(true);
    },
    [selectedCategory, t],
  );

  // ── Initial fetch ──────────────────────────────────

  const initialFetchDone = useRef(false);
  useEffect(() => {
    if (initialFetchDone.current) {
      return;
    }
    initialFetchDone.current = true;
    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget in effect
    fetchCategories();
    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget in effect
    fetchClauses();
  }, [fetchCategories, fetchClauses]);

  // ── Category change ────────────────────────────────

  const handleCategorySelect = useCallback((categoryId: string | null) => {
    setSelectedCategory(categoryId);
    setClauses([]);
    setNextCursor(null);
    setLoaded(false);
  }, []);

  // Refetch when selectedCategory changes (after initial)
  const prevFetchRef = useRef(fetchClauses);
  useEffect(() => {
    if (prevFetchRef.current === fetchClauses) {
      return;
    }
    prevFetchRef.current = fetchClauses;
    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget in effect
    fetchClauses();
  }, [fetchClauses]);

  // ── Handlers ───────────────────────────────────────

  const handleLoadMore = useCallback(() => {
    if (nextCursor) {
      // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget
      fetchClauses(nextCursor);
    }
  }, [nextCursor, fetchClauses]);

  const handleRefresh = useCallback(() => {
    setClauses([]);
    setNextCursor(null);
    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget
    fetchClauses();
    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget
    fetchCategories();
  }, [fetchClauses, fetchCategories]);

  // ── Render ─────────────────────────────────────────

  if (view.kind === "detail") {
    return (
      <ClauseDetailView
        categories={categories}
        clauseId={view.clauseId}
        onBack={() => {
          setView({ kind: "list" });
          handleRefresh();
        }}
        onDeleted={() => {
          setView({ kind: "list" });
          handleRefresh();
        }}
      />
    );
  }

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t("clauses.loading")}</p>
      </div>
    );
  }

  return (
    <>
      <ClauseList
        categories={categories}
        clauses={clauses}
        loading={loading}
        nextCursor={nextCursor}
        onCategoriesChanged={() => {
          // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget
          fetchCategories();
        }}
        onCategorySelect={handleCategorySelect}
        onClauseSelect={(clause) =>
          setView({
            kind: "detail",
            clauseId: clause.id,
          })
        }
        onLoadMore={handleLoadMore}
        onNewClause={() => setCreateOpen(true)}
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
