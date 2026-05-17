import { useCallback, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import {
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TextQuoteIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useFormatter, useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import {
  toAPIError,
  userErrorFromThrown,
  userErrorMessage,
} from "@/lib/errors";
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
      <CategorySidebar
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

// ── Category Sidebar ─────────────────────────────────

const CategorySidebar = ({
  categories,
  selectedId,
  onSelect,
  onCategoriesChanged,
}: {
  categories: CategoryItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCategoriesChanged: () => void;
}) => {
  const t = useTranslations();
  const canCreateClause = usePermissions({ clause: ["create"] });
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex w-48 shrink-0 flex-col overflow-y-auto">
      <nav className="flex-1 p-2">
        <button
          className={`w-full rounded-md px-3 py-1.5 text-start text-sm ${
            selectedId === null ? "bg-muted font-medium" : "hover:bg-muted/50"
          }`}
          onClick={() => onSelect(null)}
          type="button"
        >
          {t("clauses.allClauses")}
        </button>
        <button
          className={`w-full rounded-md px-3 py-1.5 text-start text-sm ${
            selectedId === "uncategorized"
              ? "bg-muted font-medium"
              : "hover:bg-muted/50"
          }`}
          onClick={() => onSelect("uncategorized")}
          type="button"
        >
          {t("common.uncategorized")}
        </button>

        {categories.length > 0 && <div className="my-1 border-t" />}

        {categories.map((cat) => (
          <CategoryRow
            category={cat}
            isSelected={selectedId === cat.id}
            key={cat.id}
            onCategoriesChanged={onCategoriesChanged}
            onSelect={() => onSelect(cat.id)}
          />
        ))}
      </nav>

      {canCreateClause && (
        <div className="border-t p-2">
          <Button
            className="w-full justify-start"
            onClick={() => setCreateOpen(true)}
            size="sm"
            variant="ghost"
          >
            <PlusIcon />
            {t("clauses.createCategory")}
          </Button>
        </div>
      )}

      <CategoryFormDialog
        onOpenChange={setCreateOpen}
        onSaved={onCategoriesChanged}
        open={createOpen}
      />
    </div>
  );
};

// ── Category Row ─────────────────────────────────────

const CategoryRow = ({
  category,
  isSelected,
  onSelect,
  onCategoriesChanged,
}: {
  category: CategoryItem;
  isSelected: boolean;
  onSelect: () => void;
  onCategoriesChanged: () => void;
}) => {
  const t = useTranslations();
  const canUpdateClause = usePermissions({ clause: ["update"] });
  const canDeleteClause = usePermissions({ clause: ["delete"] });
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteCategory = useMutation({
    mutationFn: async () => {
      const response = await api["clause-categories"]({
        categoryId: category.id,
      }).delete();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      setDeleteOpen(false);
      onCategoriesChanged();
    },
    onError: (error) => {
      stellaToast.add({
        type: "error",
        title: t("clauses.deleteFailed"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    },
  });

  return (
    <div className="group flex items-center">
      <button
        className={`min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-start text-sm ${
          isSelected ? "bg-muted font-medium" : "hover:bg-muted/50"
        }`}
        onClick={onSelect}
        type="button"
      >
        {category.name}
      </button>

      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                className="invisible shrink-0 group-hover:visible"
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {canUpdateClause && (
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <PencilIcon />
                {t("clauses.editCategory")}
              </DropdownMenuItem>
            )}
            {canDeleteClause && (
              <DropdownMenuItem
                className="text-destructive-foreground"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2Icon />
                {t("clauses.deleteCategory")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("clauses.deleteCategory")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("clauses.categoryDeleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={deleteCategory.isPending}
              onClick={() => {
                deleteCategory.mutate();
              }}
              variant="destructive"
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <CategoryFormDialog
        initial={{
          id: category.id,
          name: category.name,
        }}
        onOpenChange={setEditOpen}
        onSaved={onCategoriesChanged}
        open={editOpen}
      />
    </div>
  );
};

// ── Category Form Dialog ─────────────────────────────

type CategoryFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  initial?: { id: string; name: string };
};

const CategoryFormDialog = ({
  open,
  onOpenChange,
  onSaved,
  initial,
}: CategoryFormDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {/* Mount only while open so each open instantiates a fresh
        form: cancel-then-reopen discards unsaved edits (the
        behaviour the removed `open`-driven reset effect provided),
        and switching between create/edit-for-same-id re-seeds from
        `initial` without an effect. */}
    {open ? (
      <CategoryFormDialogBody
        initial={initial}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    ) : null}
  </Dialog>
);

type CategoryFormDialogBodyProps = {
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  initial: { id: string; name: string } | undefined;
};

const CategoryFormDialogBody = ({
  onOpenChange,
  onSaved,
  initial,
}: CategoryFormDialogBodyProps) => {
  const t = useTranslations();
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      return;
    }

    setSaving(true);

    if (isEdit && initial.id) {
      const response = await api["clause-categories"]({
        categoryId: initial.id,
      }).post({ name: name.trim() });

      setSaving(false);

      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("clauses.saveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }
    } else {
      const response = await api["clause-categories"].put({
        name: name.trim(),
      });

      setSaving(false);

      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("clauses.saveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }
    }

    onOpenChange(false);
    onSaved();
  }, [name, isEdit, initial, t, onOpenChange, onSaved]);

  return (
    <DialogPopup className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>
          {isEdit ? t("clauses.editCategory") : t("clauses.createCategory")}
        </DialogTitle>
      </DialogHeader>
      <DialogPanel className="grid gap-4">
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="category-name">
            {t("clauses.categoryName")}
          </label>
          <Input
            id="category-name"
            onChange={(e) => setName(e.target.value)}
            placeholder={t("clauses.categoryNamePlaceholder")}
            value={name}
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={saving || !name.trim()}
          onClick={() => {
            void handleSave();
          }}
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};
