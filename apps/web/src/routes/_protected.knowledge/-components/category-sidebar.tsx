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
import { cn } from "@stll/ui/lib/utils";

import { ContextMenu } from "@/components/context-menu";
import type { ContextMenuAction } from "@/components/context-menu";

// ── Types ────────────────────────────────────────────

export type CategoryEntity = { id: string; name: string };

/** Entity-agnostic CRUD operations supplied by the caller. The ops own their
 *  feature-specific API path; permissions are resolved upstream; and the ops
 *  surface their own error toast. `create` resolves to the new category (or
 *  `null` on failure); `rename`/`remove` resolve to a success boolean. */
export type CategoryOps = {
  create: (name: string) => Promise<CategoryEntity | null>;
  rename: (id: string, name: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
};

/** Granular gating, resolved by the caller. Kept separate (not one "canManage"
 *  flag) so a role with, say, create+update but not delete still sees the
 *  affordances it is entitled to. */
export type CategoryPermissions = {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

/** Already-translated copy for the sidebar chrome and the form/confirm dialogs.
 *  Kept as resolved strings so the shared component never reaches into a
 *  feature-scoped i18n namespace (templates.* vs clauses.*). Shared
 *  `common.*` strings (Uncategorized, Cancel, Save, Delete) are resolved
 *  internally. */
export type CategoryLabels = {
  /** "All templates" / "All clauses" (the unscoped first entry). */
  all: string;
  createCategory: string;
  editCategory: string;
  deleteCategory: string;
  deleteConfirm: string;
  nameLabel: string;
  namePlaceholder: string;
};

/** Drag-and-drop wiring, supplied only by features that support reassigning a
 *  dragged item onto a category (Templates). When omitted, no drop targets
 *  render (Clauses). */
export type CategoryDragAndDrop = {
  mime: string;
  onAssign: (itemId: string, categoryId: string | null) => void | Promise<void>;
};

type CategorySidebarProps = {
  categories: CategoryEntity[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  permissions: CategoryPermissions;
  labels: CategoryLabels;
  ops: CategoryOps;
  dragAndDrop?: CategoryDragAndDrop;
  /** Fires after a successful create with the new category, so callers can act
   *  on it — e.g. assign the item that triggered the create-and-assign flow. */
  onCategoryCreated?: (category: CategoryEntity) => void;
  /** Optional extra content rendered below the category list (e.g. the
   *  Templates tag filter). */
  children?: React.ReactNode;
};

export const CategorySidebar = ({
  categories,
  selectedId,
  onSelect,
  onChanged,
  permissions,
  labels,
  ops,
  dragAndDrop,
  onCategoryCreated,
  children,
}: CategorySidebarProps) => {
  const t = useTranslations();
  const [createOpen, setCreateOpen] = useState(false);

  const createCategoryActions: ContextMenuAction[] = permissions.canCreate
    ? [
        {
          label: labels.createCategory,
          icon: <PlusIcon />,
          onClick: () => setCreateOpen(true),
        },
      ]
    : [];

  return (
    <div className="flex w-48 shrink-0 flex-col overflow-y-auto">
      <ContextMenu actions={createCategoryActions}>
        <nav className="flex-1 p-2">
          <CategoryNavButton
            dragAndDrop={dragAndDrop}
            isSelected={selectedId === null}
            label={labels.all}
            onSelect={() => onSelect(null)}
            targetCategoryId={null}
          />
          <CategoryNavButton
            dragAndDrop={dragAndDrop}
            isSelected={selectedId === "uncategorized"}
            label={t("common.uncategorized")}
            onSelect={() => onSelect("uncategorized")}
            targetCategoryId={null}
          />

          {categories.length > 0 && <div className="my-1 border-t" />}

          {categories.map((cat) => (
            <CategoryRow
              category={cat}
              dragAndDrop={dragAndDrop}
              isSelected={selectedId === cat.id}
              key={cat.id}
              labels={labels}
              onChanged={onChanged}
              onSelect={() => onSelect(cat.id)}
              ops={ops}
              permissions={permissions}
            />
          ))}

          {children}
        </nav>
      </ContextMenu>

      {permissions.canCreate && (
        <div className="border-t p-2">
          <Button
            className="w-full justify-start"
            onClick={() => setCreateOpen(true)}
            size="sm"
            variant="ghost"
          >
            <PlusIcon />
            {labels.createCategory}
          </Button>
        </div>
      )}

      <CategoryFormDialog
        labels={labels}
        onChanged={onChanged}
        onCreated={onCategoryCreated}
        onOpenChange={setCreateOpen}
        open={createOpen}
        ops={ops}
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

const noop = () => undefined;

/** Inert handlers for features without drag-and-drop, so callers can spread the
 *  hook result unconditionally and no drop affordance ever activates. */
const INERT_DROP_TARGET: DropTarget = {
  isDragOver: false,
  onDragOver: noop,
  onDragLeave: noop,
  onDrop: noop,
};

/** Wires the dragged-item drop affordance for a category target. Returns inert
 *  no-op handlers (and `isDragOver: false`) when the feature does not opt into
 *  drag-and-drop, so callers can spread the result unconditionally. */
const useCategoryDropTarget = (
  dragAndDrop: CategoryDragAndDrop | undefined,
  targetCategoryId: string | null,
): DropTarget => {
  const [isDragOver, setIsDragOver] = useState(false);

  if (!dragAndDrop) {
    return INERT_DROP_TARGET;
  }

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(dragAndDrop.mime)) {
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
    const itemId = e.dataTransfer.getData(dragAndDrop.mime);
    if (itemId) {
      void dragAndDrop.onAssign(itemId, targetCategoryId);
    }
  };

  return { isDragOver, onDragOver, onDragLeave, onDrop };
};

// ── Nav button (All / Uncategorized) ────────────────

type CategoryNavButtonProps = {
  label: string;
  isSelected: boolean;
  onSelect: () => void;
  dragAndDrop: CategoryDragAndDrop | undefined;
  targetCategoryId: string | null;
};

const CategoryNavButton = ({
  label,
  isSelected,
  onSelect,
  dragAndDrop,
  targetCategoryId,
}: CategoryNavButtonProps) => {
  const drop = useCategoryDropTarget(dragAndDrop, targetCategoryId);

  return (
    <button
      className={cn(
        "w-full truncate rounded-md px-3 py-1.5 text-start text-sm transition-colors",
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

type CategoryRowProps = {
  category: CategoryEntity;
  isSelected: boolean;
  permissions: CategoryPermissions;
  labels: CategoryLabels;
  ops: CategoryOps;
  onSelect: () => void;
  onChanged: () => void;
  dragAndDrop: CategoryDragAndDrop | undefined;
};

const CategoryRow = ({
  category,
  isSelected,
  permissions,
  labels,
  ops,
  onSelect,
  onChanged,
  dragAndDrop,
}: CategoryRowProps) => {
  const t = useTranslations();
  const drop = useCategoryDropTarget(dragAndDrop, category.id);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    const ok = await ops.remove(category.id);
    setDeleting(false);

    if (!ok) {
      return;
    }

    setDeleteOpen(false);
    onChanged();
  }, [category.id, ops, onChanged]);

  return (
    <div
      className={cn(
        "group flex items-center rounded-md transition-colors",
        isSelected ? "bg-muted" : "hover:bg-muted/50",
        drop.isDragOver && "ring-primary bg-muted ring-2 ring-inset",
      )}
      onDragLeave={drop.onDragLeave}
      onDragOver={drop.onDragOver}
      onDrop={drop.onDrop}
    >
      <button
        className={cn(
          "min-w-0 flex-1 truncate px-3 py-1.5 text-start text-sm",
          isSelected && "font-medium",
        )}
        onClick={onSelect}
        type="button"
      >
        {category.name}
      </button>

      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        {(permissions.canUpdate || permissions.canDelete) && (
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
              {permissions.canUpdate && (
                <DropdownMenuItem onClick={() => setEditOpen(true)}>
                  <PencilIcon />
                  {labels.editCategory}
                </DropdownMenuItem>
              )}
              {permissions.canDelete && (
                <DropdownMenuItem
                  className="text-destructive-foreground"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2Icon />
                  {labels.deleteCategory}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{labels.deleteCategory}</AlertDialogTitle>
            <AlertDialogDescription>
              {labels.deleteConfirm}
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
        initial={category}
        labels={labels}
        onChanged={onChanged}
        onOpenChange={setEditOpen}
        open={editOpen}
        ops={ops}
      />
    </div>
  );
};

// ── Category Form Dialog ────────────────────────────

type CategoryFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  labels: CategoryLabels;
  ops: CategoryOps;
  /** Fires after a successful create (not edit) with the new category, so
   *  callers can act on it — e.g. assign the row that triggered the create. */
  onCreated?: (category: CategoryEntity) => void;
  initial?: CategoryEntity;
};

export const CategoryFormDialog = ({
  open,
  onOpenChange,
  onChanged,
  labels,
  ops,
  onCreated,
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
        labels={labels}
        onChanged={onChanged}
        onCreated={onCreated}
        onOpenChange={onOpenChange}
        ops={ops}
      />
    ) : null}
  </Dialog>
);

type CategoryFormDialogBodyProps = {
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  labels: CategoryLabels;
  ops: CategoryOps;
  onCreated?: (category: CategoryEntity) => void;
  initial: CategoryEntity | undefined;
};

const CategoryFormDialogBody = ({
  onOpenChange,
  onChanged,
  labels,
  ops,
  onCreated,
  initial,
}: CategoryFormDialogBodyProps) => {
  const t = useTranslations();
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    setSaving(true);

    if (initial) {
      const ok = await ops.rename(initial.id, trimmed);
      setSaving(false);
      if (!ok) {
        return;
      }
    } else {
      const created = await ops.create(trimmed);
      setSaving(false);
      if (!created) {
        return;
      }
      onCreated?.(created);
    }

    onOpenChange(false);
    onChanged();
  }, [name, initial, ops, onOpenChange, onChanged, onCreated]);

  return (
    <DialogPopup className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>
          {isEdit ? labels.editCategory : labels.createCategory}
        </DialogTitle>
      </DialogHeader>
      <DialogPanel className="grid gap-4">
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="category-name">
            {labels.nameLabel}
          </label>
          <Input
            id="category-name"
            onChange={(e) => setName(e.target.value)}
            placeholder={labels.namePlaceholder}
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
