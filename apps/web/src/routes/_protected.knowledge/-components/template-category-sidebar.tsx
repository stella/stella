import { useCallback, useEffect, useState } from "react";
import {
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stella/ui/components/alert-dialog";
import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stella/ui/components/dialog";
import { Input } from "@stella/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@stella/ui/components/menu";
import { toastManager } from "@stella/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";

// ── Types ────────────────────────────────────────────

export type TemplateCategoryItem = {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
};

type TemplateCategorySidebarProps = {
  categories: TemplateCategoryItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCategoriesChanged: () => void;
};

// ── Sidebar ─────────────────────────────────────────

export const TemplateCategorySidebar = ({
  categories,
  selectedId,
  onSelect,
  onCategoriesChanged,
}: TemplateCategorySidebarProps) => {
  const t = useTranslations();
  const canCreateTemplate = usePermissions({ template: ["create"] });
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex w-48 shrink-0 flex-col overflow-y-auto">
      <nav className="flex-1 p-2">
        <button
          className={`w-full rounded-md px-3 py-1.5 text-left text-sm ${
            selectedId === null ? "bg-muted font-medium" : "hover:bg-muted/50"
          }`}
          onClick={() => onSelect(null)}
          type="button"
        >
          {t("templates.allTemplates")}
        </button>
        <button
          className={`w-full rounded-md px-3 py-1.5 text-left text-sm ${
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

      {canCreateTemplate && (
        <div className="border-t p-2">
          <Button
            className="w-full justify-start"
            onClick={() => setCreateOpen(true)}
            size="sm"
            variant="ghost"
          >
            <PlusIcon />
            {t("templates.createCategory")}
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

// ── Category Row ────────────────────────────────────

const CategoryRow = ({
  category,
  isSelected,
  onSelect,
  onCategoriesChanged,
}: {
  category: TemplateCategoryItem;
  isSelected: boolean;
  onSelect: () => void;
  onCategoriesChanged: () => void;
}) => {
  const t = useTranslations();
  const canUpdateTemplate = usePermissions({ template: ["update"] });
  const canDeleteTemplate = usePermissions({ template: ["delete"] });
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    const response = await api["template-categories"]({
      categoryId: category.id,
    }).delete();

    setDeleting(false);

    if (response.error) {
      toastManager.add({
        type: "error",
        title: t("templates.categoryDeleteFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    setDeleteOpen(false);
    onCategoriesChanged();
  }, [category.id, t, onCategoriesChanged]);

  return (
    <div className="group flex items-center">
      <button
        className={`min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-left text-sm ${
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
            {canUpdateTemplate && (
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <PencilIcon />
                {t("templates.editCategory")}
              </DropdownMenuItem>
            )}
            {canDeleteTemplate && (
              <DropdownMenuItem
                className="text-destructive-foreground"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2Icon />
                {t("templates.deleteCategory")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("templates.deleteCategory")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("templates.categoryDeleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={deleting}
              onClick={handleDelete}
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

// ── Category Form Dialog ────────────────────────────

const CategoryFormDialog = ({
  open,
  onOpenChange,
  onSaved,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  initial?: { id: string; name: string };
}) => {
  const t = useTranslations();
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
    }
  }, [open, initial?.name]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      return;
    }

    setSaving(true);

    if (isEdit && initial?.id) {
      const response = await api["template-categories"]({
        categoryId: initial.id,
      }).post({ name: name.trim() });

      setSaving(false);

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("templates.categorySaveFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }
    } else {
      const response = await api["template-categories"].put({
        name: name.trim(),
      });

      setSaving(false);

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("templates.categorySaveFailed"),
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
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("templates.editCategory")
              : t("templates.createCategory")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="grid gap-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="template-category-name"
            >
              {t("templates.categoryName")}
            </label>
            <Input
              id="template-category-name"
              onChange={(e) => setName(e.target.value)}
              placeholder={t("templates.categoryName")}
              value={name}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button disabled={saving || !name.trim()} onClick={handleSave}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
