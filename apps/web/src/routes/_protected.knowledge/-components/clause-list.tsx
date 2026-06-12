import { useCallback, useState } from "react";

import {
  DownloadIcon,
  PlusIcon,
  SearchIcon,
  TextQuoteIcon,
  UploadIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { CategorySidebar } from "@/routes/_protected.knowledge/-components/category-sidebar";
import type {
  CategoryLabels,
  CategoryOps,
} from "@/routes/_protected.knowledge/-components/category-sidebar";
import { ClauseImportDialog } from "@/routes/_protected.knowledge/-components/clause-import-dialog";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

// ── Types ────────────────────────────────────────────

type CategoryItem = {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
};

type ClauseItem = {
  id: string;
  title: string;
  categoryId: string | null;
  currentVersion: number;
  createdAt: Date;
};

type ClauseListProps = {
  categories: CategoryItem[];
  clauses: ClauseItem[];
  nextCursor: string | null;
  selectedCategoryId: string | null;
  onCategorySelect: (categoryId: string | null) => void;
  onClauseSelect: (clause: ClauseItem) => void;
  onNewClause: () => void;
  onLoadMore: () => void;
  onCategoriesChanged: () => void;
  onSearch: (q: string) => void;
  onRefresh: () => void;
  loading: boolean;
};

// ── Main Component ───────────────────────────────────

export const ClauseList = ({
  categories,
  clauses,
  nextCursor,
  selectedCategoryId,
  onCategorySelect,
  onClauseSelect,
  onNewClause,
  onLoadMore,
  onCategoriesChanged,
  onSearch,
  onRefresh,
  loading,
}: ClauseListProps) => {
  const t = useTranslations();
  const canCreateClause = usePermissions({ clause: ["create"] });
  const [searchInput, setSearchInput] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const debouncedSearch = useDebouncedCallback(
    (value: string) => onSearch(value),
    300,
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchInput(e.target.value);
      debouncedSearch(e.target.value);
    },
    [debouncedSearch],
  );

  const handleExport = useCallback(async () => {
    const response = await api.clauses.export.get({
      query: {},
    });

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.exportFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    const { data } = response;
    if (data instanceof Response) {
      const blob = await data.blob();
      downloadFile(blob, "clauses-export.json");
      return;
    }

    // Eden may return parsed JSON; wrap in Blob
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    downloadFile(blob, "clauses-export.json");
  }, [t]);

  return (
    <div className="flex min-h-0 flex-1">
      {/* Category sidebar */}
      <ClauseCategorySidebar
        categories={categories}
        onCategoriesChanged={onCategoriesChanged}
        onSelect={onCategorySelect}
        selectedId={selectedCategoryId}
      />

      {/* Clause list */}
      <div className="flex min-h-0 flex-1 flex-col border-s">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="relative me-3 flex-1">
            <SearchIcon className="text-muted-foreground absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
            <Input
              className="h-8 ps-8"
              onChange={handleSearchChange}
              placeholder={t("clauses.searchPlaceholder")}
              value={searchInput}
            />
          </div>
          <div className="flex gap-1">
            {canCreateClause && (
              <Button
                onClick={() => setImportOpen(true)}
                size="sm"
                variant="outline"
              >
                <UploadIcon />
                {t("clauses.import")}
              </Button>
            )}
            <Button
              onClick={() => {
                void handleExport();
              }}
              size="sm"
              variant="outline"
            >
              <DownloadIcon />
              {t("clauses.export")}
            </Button>
            {canCreateClause && (
              <Button onClick={onNewClause} size="sm">
                <PlusIcon />
                {t("clauses.createClause")}
              </Button>
            )}
          </div>
        </div>

        <ClauseImportDialog
          onImported={onRefresh}
          onOpenChange={setImportOpen}
          open={importOpen}
        />

        <div className="flex-1 overflow-y-auto">
          {clauses.length === 0 && !loading && (
            <div className="flex items-center justify-center p-8">
              <p className="text-muted-foreground text-sm">
                {t("clauses.noResults")}
              </p>
            </div>
          )}

          <ul className="divide-y">
            {clauses.map((clause) => (
              <ClauseRow
                categories={categories}
                clause={clause}
                key={clause.id}
                onSelect={() => onClauseSelect(clause)}
              />
            ))}
          </ul>

          {nextCursor && (
            <div className="flex justify-center border-t p-3">
              <Button
                disabled={loading}
                onClick={onLoadMore}
                size="sm"
                variant="ghost"
              >
                {t("common.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Clause Row ───────────────────────────────────────

const ClauseRow = ({
  clause,
  categories,
  onSelect,
}: {
  clause: ClauseItem;
  categories: CategoryItem[];
  onSelect: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  const categoryName = clause.categoryId
    ? categories.find((c) => c.id === clause.categoryId)?.name
    : null;

  return (
    <li>
      <button
        className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-start"
        onClick={onSelect}
        type="button"
      >
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
          <TextQuoteIcon className="text-muted-foreground size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{clause.title}</p>
          <p className="text-muted-foreground text-xs">
            {categoryName ?? t("common.uncategorized")}
            {" \u00b7 "}
            {format.dateTime(new Date(clause.createdAt), {
              dateStyle: "medium",
            })}
          </p>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          {t("clauses.version", {
            version: String(clause.currentVersion),
          })}
        </span>
      </button>
    </li>
  );
};

// ── Category sidebar (clause-flavoured) ──────────────

type ClauseCategorySidebarProps = {
  categories: CategoryItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCategoriesChanged: () => void;
};

/** Thin wrapper over the shared `CategorySidebar`: resolves clause
 *  permissions, wires the clause-categories api ops, and supplies the
 *  clause-scoped labels. No drag-and-drop (clauses are not draggable). */
const ClauseCategorySidebar = ({
  categories,
  selectedId,
  onSelect,
  onCategoriesChanged,
}: ClauseCategorySidebarProps) => {
  const canCreate = usePermissions({ clause: ["create"] });
  const canUpdate = usePermissions({ clause: ["update"] });
  const canDelete = usePermissions({ clause: ["delete"] });
  const ops = useClauseCategoryOps();
  const labels = useClauseCategoryLabels();

  return (
    <CategorySidebar
      categories={categories}
      labels={labels}
      onChanged={onCategoriesChanged}
      onSelect={onSelect}
      ops={ops}
      permissions={{ canCreate, canUpdate, canDelete }}
      selectedId={selectedId}
    />
  );
};

/** Clause-categories CRUD wired to the api treaty. Each op surfaces its own
 *  error toast and resolves to the shared `CategoryOps` contract. */
const useClauseCategoryOps = (): CategoryOps => {
  const t = useTranslations();

  return {
    create: async (name) => {
      const response = await api["clause-categories"].put({ name });
      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("clauses.saveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return null;
      }
      return { id: response.data.id, name: response.data.name };
    },
    rename: async (id, name) => {
      const response = await api["clause-categories"]({
        categoryId: id,
      }).post({ name });
      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("clauses.saveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return false;
      }
      return true;
    },
    remove: async (id) => {
      const response = await api["clause-categories"]({
        categoryId: id,
      }).delete();
      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("clauses.deleteFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return false;
      }
      return true;
    },
  };
};

const useClauseCategoryLabels = (): CategoryLabels => {
  const t = useTranslations();
  return {
    all: t("clauses.allClauses"),
    createCategory: t("clauses.createCategory"),
    editCategory: t("clauses.editCategory"),
    deleteCategory: t("clauses.deleteCategory"),
    deleteConfirm: t("clauses.categoryDeleteConfirm"),
    nameLabel: t("clauses.categoryName"),
    namePlaceholder: t("clauses.categoryNamePlaceholder"),
  };
};
