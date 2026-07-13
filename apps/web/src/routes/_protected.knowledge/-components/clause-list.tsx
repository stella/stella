import { useState } from "react";

import {
  DownloadIcon,
  PlusIcon,
  SearchIcon,
  TextQuoteIcon,
  UploadIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
import { stellaToast } from "@stll/ui/components/toast";

import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@/components/responsive-action-toolbar";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { downloadFile } from "@/lib/utils";
import {
  CategoryFormDialog,
  CategoryMobileFilterBar,
  CategorySidebar,
} from "@/routes/_protected.knowledge/-components/category-sidebar";
import type {
  CategoryLabels,
  CategoryOps,
} from "@/routes/_protected.knowledge/-components/category-sidebar";
import { ClauseImportDialog } from "@/routes/_protected.knowledge/-components/clause-import-dialog";

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
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
  const categoryLabels = useClauseCategoryLabels();
  const categoryOps = useClauseCategoryOps();

  const debouncedSearch = useDebouncedCallback(
    (value: string) => onSearch(value),
    300,
  );

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
    debouncedSearch(e.target.value);
  };

  const handleExport = async () => {
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
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="hidden md:contents">
        <ClauseCategorySidebar
          categories={categories}
          labels={categoryLabels}
          onCategoriesChanged={onCategoriesChanged}
          onSelect={onCategorySelect}
          ops={categoryOps}
          selectedId={selectedCategoryId}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:border-s">
        <div className="border-b px-4 py-2">
          <ResponsiveActionToolbar>
            <ResponsiveActionToolbarItem slot="primary">
              <InputGroup className="min-h-11 sm:min-h-0">
                <InputGroupInput
                  className="max-sm:h-11 max-sm:leading-11"
                  onChange={handleSearchChange}
                  placeholder={t("clauses.searchPlaceholder")}
                  size="sm"
                  type="search"
                  value={searchInput}
                />
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
              </InputGroup>
            </ResponsiveActionToolbarItem>
            <ResponsiveActionToolbarItem
              className="ms-auto sm:ms-0"
              slot="action"
            >
              <div className="flex gap-1">
                {canCreateClause && (
                  <Button
                    aria-label={t("common.import")}
                    onClick={() => setImportOpen(true)}
                    size="sm"
                    title={t("common.import")}
                    variant="outline"
                  >
                    <UploadIcon />
                    <span className="hidden sm:inline">
                      {t("common.import")}
                    </span>
                  </Button>
                )}
                <Button
                  aria-label={t("clauses.export")}
                  onClick={() => {
                    void handleExport();
                  }}
                  size="sm"
                  title={t("clauses.export")}
                  variant="outline"
                >
                  <DownloadIcon />
                  <span className="hidden sm:inline">
                    {t("clauses.export")}
                  </span>
                </Button>
                {canCreateClause && (
                  <Button
                    aria-label={t("clauses.createClause")}
                    onClick={onNewClause}
                    size="sm"
                    title={t("clauses.createClause")}
                  >
                    <PlusIcon />
                    <span className="hidden sm:inline">
                      {t("clauses.createClause")}
                    </span>
                  </Button>
                )}
              </div>
            </ResponsiveActionToolbarItem>
          </ResponsiveActionToolbar>
        </div>

        <CategoryMobileFilterBar
          canCreate={canCreateClause}
          categories={categories}
          labels={categoryLabels}
          onCreateCategory={() => setCreateCategoryOpen(true)}
          onSelect={onCategorySelect}
          selectedId={selectedCategoryId}
        />

        <CategoryFormDialog
          labels={categoryLabels}
          onChanged={onCategoriesChanged}
          onOpenChange={setCreateCategoryOpen}
          open={createCategoryOpen}
          ops={categoryOps}
        />

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
          <p className="truncate text-sm font-medium" dir="auto">
            {clause.title}
          </p>
          <p className="text-muted-foreground text-xs">
            {categoryName ?? t("common.uncategorized")}
            {" \u00b7 "}
            {format.dateTime(new Date(clause.createdAt), {
              dateStyle: "medium",
            })}
          </p>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          {t("common.versionLabel", {
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
  labels: CategoryLabels;
  ops: CategoryOps;
};

/** Thin wrapper over the shared `CategorySidebar`: resolves clause
 *  permissions, wires the clause-categories api ops, and supplies the
 *  clause-scoped labels. No drag-and-drop (clauses are not draggable). */
const ClauseCategorySidebar = ({
  categories,
  selectedId,
  onSelect,
  onCategoriesChanged,
  labels,
  ops,
}: ClauseCategorySidebarProps) => {
  const canCreate = usePermissions({ clause: ["create"] });
  const canUpdate = usePermissions({ clause: ["update"] });
  const canDelete = usePermissions({ clause: ["delete"] });

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
    createCategory: t("common.createCategory"),
    editCategory: t("common.editCategory"),
    deleteCategory: t("common.deleteCategory"),
    deleteConfirm: t("clauses.categoryDeleteConfirm"),
    nameLabel: t("common.categoryName"),
    namePlaceholder: t("clauses.categoryNamePlaceholder"),
  };
};
