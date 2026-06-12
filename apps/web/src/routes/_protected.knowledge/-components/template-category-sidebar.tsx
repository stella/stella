import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import {
  CategoryFormDialog as SharedCategoryFormDialog,
  CategorySidebar,
} from "@/routes/_protected.knowledge/-components/category-sidebar";
import type {
  CategoryEntity,
  CategoryLabels,
  CategoryOps,
} from "@/routes/_protected.knowledge/-components/category-sidebar";
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

// ── Template ops + labels ───────────────────────────

/** Template-categories CRUD wired to the api treaty. Each op surfaces its own
 *  error toast and resolves to the shared `CategoryOps` contract (created
 *  category or `null`; success boolean). */
const useTemplateCategoryOps = (): CategoryOps => {
  const t = useTranslations();

  return {
    create: async (name) => {
      const response = await api["template-categories"].put({ name });
      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("templates.categorySaveFailed"),
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
      const response = await api["template-categories"]({
        categoryId: id,
      }).post({ name });
      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("templates.categorySaveFailed"),
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
      const response = await api["template-categories"]({
        categoryId: id,
      }).delete();
      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("templates.categoryDeleteFailed"),
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

const useTemplateCategoryLabels = (): CategoryLabels => {
  const t = useTranslations();
  return {
    all: t("templates.allTemplates"),
    createCategory: t("templates.createCategory"),
    editCategory: t("templates.editCategory"),
    deleteCategory: t("templates.deleteCategory"),
    deleteConfirm: t("templates.categoryDeleteConfirm"),
    nameLabel: t("templates.categoryName"),
    namePlaceholder: t("templates.categoryName"),
  };
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
  const canCreate = usePermissions({ template: ["create"] });
  const canUpdate = usePermissions({ template: ["update"] });
  const canDelete = usePermissions({ template: ["delete"] });
  const ops = useTemplateCategoryOps();
  const labels = useTemplateCategoryLabels();

  return (
    <CategorySidebar
      categories={categories}
      permissions={{ canCreate, canUpdate, canDelete }}
      dragAndDrop={{
        mime: TEMPLATE_DRAG_MIME,
        onAssign: onAssignCategory,
      }}
      labels={labels}
      onChanged={onCategoriesChanged}
      onSelect={onSelect}
      ops={ops}
      selectedId={selectedId}
    >
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
    </CategorySidebar>
  );
};

// ── Create dialog (template-list "+ New category" action) ──

type CategoryFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onCreated?: (category: CategoryEntity) => void;
  initial?: CategoryEntity;
};

/** Template-flavoured wrapper over the shared dialog: injects the
 *  template-categories ops and labels so call sites (e.g. the per-row
 *  create-and-assign action) need only the open/saved/created wiring. */
export const CategoryFormDialog = ({
  open,
  onOpenChange,
  onSaved,
  onCreated,
  initial,
}: CategoryFormDialogProps) => {
  const ops = useTemplateCategoryOps();
  const labels = useTemplateCategoryLabels();

  return (
    <SharedCategoryFormDialog
      initial={initial}
      labels={labels}
      onChanged={onSaved}
      onCreated={onCreated}
      onOpenChange={onOpenChange}
      open={open}
      ops={ops}
    />
  );
};
