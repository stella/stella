import { useCallback, useState } from "react";

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
import { cn } from "@stll/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { TEMPLATE_DRAG_MIME } from "@/routes/_protected.knowledge/-components/template-drag";

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
  onAssignCategory: (
    templateId: string,
    categoryId: string | null,
  ) => Promise<void>;
  tags: string[];
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
};

// ── Sidebar ─────────────────────────────────────────

export const TemplateCategorySidebar = ({
  categories,
  selectedId,
  onSelect,
  onCategoriesChanged,
  onAssignCategory,
  tags,
  selectedTag,
  onSelectTag,
}: TemplateCategorySidebarProps) => {
  const t = useTranslations();
  const canCreateTemplate = usePermissions({ template: ["create"] });
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex w-48 shrink-0 flex-col overflow-y-auto">
      <nav className="flex-1 p-2">
        <CategoryNavButton
          isSelected={selectedId === null}
          label={t("templates.allTemplates")}
          onAssign={(templateId) => void onAssignCategory(templateId, null)}
          onSelect={() => onSelect(null)}
        />
        <CategoryNavButton
          isSelected={selectedId === "uncategorized"}
          label={t("common.uncategorized")}
          onAssign={(templateId) => void onAssignCategory(templateId, null)}
          onSelect={() => onSelect("uncategorized")}
        />

        {categories.length > 0 && <div className="my-1 border-t" />}

        {categories.map((cat) => (
          <CategoryRow
            category={cat}
            isSelected={selectedId === cat.id}
            key={cat.id}
            onAssign={(templateId) => void onAssignCategory(templateId, cat.id)}
            onCategoriesChanged={onCategoriesChanged}
            onSelect={() => onSelect(cat.id)}
          />
        ))}

        {tags.length > 0 && (
          <>
            <div className="text-muted-foreground mt-3 mb-1 px-3 text-xs font-medium">
              {t("templates.tags")}
            </div>
            {tags.map((tag) => (
              <button
                className={`w-full truncate rounded-md px-3 py-1.5 text-start text-sm ${
                  selectedTag === tag
                    ? "bg-muted font-medium"
                    : "hover:bg-muted/50"
                }`}
                key={tag}
                onClick={() => onSelectTag(selectedTag === tag ? null : tag)}
                type="button"
              >
                {tag}
              </button>
            ))}
          </>
        )}
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

// ── Drop target ─────────────────────────────────────

type DropTarget = {
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
};

/** Wires the dragged-template drop affordance for a category target.
 *  `onAssign` receives the dragged template id; the caller binds the
 *  destination category id (or null for All templates / Uncategorized). */
const useCategoryDropTarget = (
  onAssign: (templateId: string) => void,
): DropTarget => {
  const [isDragOver, setIsDragOver] = useState(false);

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TEMPLATE_DRAG_MIME)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const templateId = e.dataTransfer.getData(TEMPLATE_DRAG_MIME);
    if (templateId) {
      onAssign(templateId);
    }
  };

  return { isDragOver, onDragOver, onDragLeave, onDrop };
};

// ── Nav button (All templates / Uncategorized) ──────

const CategoryNavButton = ({
  label,
  isSelected,
  onSelect,
  onAssign,
}: {
  label: string;
  isSelected: boolean;
  onSelect: () => void;
  onAssign: (templateId: string) => void;
}) => {
  const drop = useCategoryDropTarget(onAssign);

  return (
    <button
      className={cn(
        "w-full rounded-md px-3 py-1.5 text-start text-sm transition-colors",
        isSelected ? "bg-muted font-medium" : "hover:bg-muted/50",
        drop.isDragOver && "ring-primary bg-muted ring-2 ring-inset",
      )}
      onClick={onSelect}
      onDragLeave={drop.onDragLeave}
      onDragOver={drop.onDragOver}
      onDrop={drop.onDrop}
      type="button"
    >
      {label}
    </button>
  );
};

// ── Category Row ────────────────────────────────────

const CategoryRow = ({
  category,
  isSelected,
  onSelect,
  onCategoriesChanged,
  onAssign,
}: {
  category: TemplateCategoryItem;
  isSelected: boolean;
  onSelect: () => void;
  onCategoriesChanged: () => void;
  onAssign: (templateId: string) => void;
}) => {
  const t = useTranslations();
  const drop = useCategoryDropTarget(onAssign);
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
      stellaToast.add({
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
    <div
      className={cn(
        "group flex items-center rounded-md transition-colors",
        drop.isDragOver && "ring-primary bg-muted ring-2 ring-inset",
      )}
      onDragLeave={drop.onDragLeave}
      onDragOver={drop.onDragOver}
      onDrop={drop.onDrop}
    >
      <button
        className={cn(
          "min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-start text-sm",
          isSelected ? "bg-muted font-medium" : "hover:bg-muted/50",
        )}
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
              onClick={() => {
                void handleDelete();
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

// ── Category Form Dialog ────────────────────────────

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
      const response = await api["template-categories"]({
        categoryId: initial.id,
      }).post({ name: name.trim() });

      setSaving(false);

      if (response.error) {
        stellaToast.add({
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
        stellaToast.add({
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
    <DialogPopup className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>
          {isEdit ? t("templates.editCategory") : t("templates.createCategory")}
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
