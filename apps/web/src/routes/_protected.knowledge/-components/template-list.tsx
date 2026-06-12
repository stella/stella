import { type CSSProperties, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  CheckIcon,
  DownloadIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PlusIcon,
  Rows2Icon,
  Rows3Icon,
  SquarePenIcon,
  TagIcon,
  Trash2Icon,
  WandSparklesIcon,
  XIcon,
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@stll/ui/components/menu";
import { SegmentedIconToggle } from "@stll/ui/components/segmented-icon-toggle";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { ContextMenu } from "@/components/context-menu";
import type { ContextMenuAction } from "@/components/context-menu";
import Tooltip from "@/components/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { usePermissions } from "@/hooks/use-permissions";
import { supportedLanguages, useI18nStore } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { DOCX_MIME, TOOLBAR_ROW_MIN_HEIGHT } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import {
  CategoryFormDialog,
  TemplateCategorySidebar,
} from "@/routes/_protected.knowledge/-components/template-category-sidebar";
import type { TemplateCategoryItem } from "@/routes/_protected.knowledge/-components/template-category-sidebar";
import { TEMPLATE_DRAG_MIME } from "@/routes/_protected.knowledge/-components/template-drag";
import { TemplateUpload } from "@/routes/_protected.knowledge/-components/template-upload";
import { UseTemplateDialog } from "@/routes/_protected.knowledge/-components/use-template-dialog";
import { knowledgeKeys } from "@/routes/_protected.knowledge/-queries";

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

type TemplateItem = {
  id: string;
  name: string;
  fileName: string;
  fieldCount: number;
  sizeBytes: number;
  categoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  useCount: number;
  tags: string[] | null;
  /** Ordered BCP-47 tags of the document text, primary language first. */
  languages: string[];
  whenToUse: string | null;
  whenNotToUse: string | null;
  authorName: string | null;
  authorImage: string | null;
};

type TemplateListProps = {
  templates: TemplateItem[];
  categories: TemplateCategoryItem[];
  selectedCategoryId: string | null;
  onCategorySelect: (id: string | null) => void;
  onCategoriesChanged: () => void;
  onDiscovered: (file: File, schema: DiscoverData) => void;
  onSelect: (template: TemplateItem) => void;
  onDeleted: () => void;
};

const protectedRouteApi = getRouteApi("/_protected");

export const TemplateList = ({
  templates,
  categories,
  selectedCategoryId,
  onCategorySelect,
  onCategoriesChanged,
  onDiscovered,
  onSelect,
  onDeleted,
}: TemplateListProps) => {
  const t = useTranslations();
  const canCreateTemplate = usePermissions({ template: ["create"] });
  const assignCategory = useAssignTemplateCategory();
  const inputRef = useRef<HTMLInputElement>(null);
  const [discovering, setDiscovering] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [density, setDensity] = useState<TemplateDensity>(readTemplateDensity);

  const changeDensity = (next: TemplateDensity) => {
    setDensity(next);
    writeTemplateDensity(next);
  };

  const discover = async (file: File) => {
    if (file.type !== DOCX_MIME) {
      stellaToast.add({
        type: "error",
        title: t("templates.invalidFileType"),
      });
      return;
    }

    setDiscovering(true);
    const response = await api.templates.discover.post({ file });
    setDiscovering(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.discoveryFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    const { data } = response;
    if (data instanceof Response) {
      stellaToast.add({
        type: "error",
        title: t("templates.discoveryFailed"),
      });
      return;
    }

    onDiscovered(file, data);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.item(0);
    if (file) {
      // Errors are surfaced as toasts inside discover
      // TODO: fix this
      // oxlint-disable-next-line no-empty-function
      discover(file).catch(() => {});
    }
    e.target.value = "";
  };

  // Only the .docx file-drop affordance — NOT the internal template-row drag
  // (which carries TEMPLATE_DRAG_MIME, not files) — should light up the list.
  const isFileDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files");

  const handleDragOver = (e: React.DragEvent) => {
    if (!canCreateTemplate || !isFileDrag(e)) {
      return;
    }
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) {
      return;
    }
    e.preventDefault();
    setIsDragOver(false);
    if (!canCreateTemplate) {
      return;
    }
    const file = e.dataTransfer.files.item(0);
    if (!file) {
      return;
    }
    if (file.type !== DOCX_MIME) {
      stellaToast.add({
        type: "error",
        title: t("templates.invalidFileType"),
      });
      return;
    }
    // Errors are surfaced as toasts inside discover
    // oxlint-disable-next-line no-empty-function
    discover(file).catch(() => {});
  };

  if (templates.length === 0 && !selectedCategoryId) {
    return <TemplateUpload onDiscovered={onDiscovered} />;
  }

  const allTags = [
    ...new Set(templates.flatMap((template) => template.tags ?? [])),
  ].sort((a, b) => a.localeCompare(b));

  const visibleTemplates = tagFilter
    ? templates.filter((template) => template.tags?.includes(tagFilter))
    : templates;

  return (
    <div
      className="relative flex min-h-0 flex-1"
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="border-foreground/30 bg-background/80 pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed opacity-100 transition-opacity">
          <p className="text-foreground text-sm font-medium">
            {t("templates.dropToCreate")}
          </p>
        </div>
      )}

      <TemplateCategorySidebar
        categories={categories}
        onAssignCategory={assignCategory}
        onCategoriesChanged={onCategoriesChanged}
        onSelect={onCategorySelect}
        onSelectTag={setTagFilter}
        selectedId={selectedCategoryId}
        selectedTag={tagFilter}
        tags={allTags}
      />

      <div className="flex min-h-0 flex-1 flex-col border-s">
        <div
          className={cn(
            "flex items-center justify-between gap-3 border-b px-4",
            TOOLBAR_ROW_MIN_HEIGHT,
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-foreground text-sm font-semibold">
              {t("knowledge.sections.templates.title")}
            </h2>
            <span className="text-muted-foreground text-sm tabular-nums">
              {visibleTemplates.length}
            </span>
            {tagFilter && (
              <span className="bg-muted text-foreground flex items-center gap-1 rounded-full py-0.5 ps-2 pe-1 text-xs font-medium">
                {tagFilter}
                <button
                  aria-label={t("common.remove")}
                  className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                  onClick={() => setTagFilter(null)}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DensityToggle density={density} onChange={changeDensity} />
            {canCreateTemplate && (
              <>
                <Button
                  disabled={discovering}
                  onClick={() => inputRef.current?.click()}
                  size="sm"
                >
                  <PlusIcon />
                  {discovering
                    ? t("templates.discovering")
                    : t("templates.newTemplate")}
                </Button>
                <input
                  accept=".docx"
                  className="hidden"
                  onChange={handleFileChange}
                  ref={inputRef}
                  type="file"
                />
              </>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {visibleTemplates.length === 0 && (
            <div className="flex items-center justify-center p-8">
              <p className="text-muted-foreground text-sm">
                {t("templates.noTemplates")}
              </p>
            </div>
          )}

          <ul className="divide-y">
            {visibleTemplates.map((template) => (
              <TemplateRow
                allTags={allTags}
                categories={categories}
                density={density}
                key={template.id}
                onAssignCategory={assignCategory}
                onCategoriesChanged={onCategoriesChanged}
                onDeleted={onDeleted}
                onSelect={() => onSelect(template)}
                template={template}
              />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

type DensityToggleProps = {
  density: TemplateDensity;
  onChange: (density: TemplateDensity) => void;
};

const DensityToggle = ({ density, onChange }: DensityToggleProps) => {
  const t = useTranslations();

  return (
    <SegmentedIconToggle
      onChange={onChange}
      options={[
        { value: "compact", icon: Rows3Icon, label: t("common.compact") },
        {
          value: "comfortable",
          icon: Rows2Icon,
          label: t("common.comfortable"),
        },
      ]}
      value={density}
    />
  );
};

// ── Row ──────────────────────────────────────────────

/** The template detail returns an audited presigned URL for the source DOCX. */
const downloadTemplateSource = async (
  templateId: string,
  errorTitle: string,
) => {
  const response = await api
    .templates({ templateId: toSafeId<"template">(templateId) })
    .get();
  if (response.error) {
    stellaToast.add({ type: "error", title: errorTitle });
    return;
  }
  window.open(response.data.presignedUrl, "_blank");
};

/** Builds a category submenu entry, marking the current one with a check and
 *  disabling it so re-assigning to the same category is a no-op. */
const categoryAction = (
  label: string,
  current: boolean,
  onClick: () => void,
): ContextMenuAction => {
  if (current) {
    return { label, icon: <CheckIcon />, disabled: true, onClick };
  }
  return { label, onClick };
};

/** Renders a single `ContextMenuAction` inside the ⋯ dropdown, mirroring the
 *  right-click `ContextMenu` so both surfaces stay driven by one array. */
const DropdownActionItem = ({ action }: { action: ContextMenuAction }) => {
  const separator = action.separatorBefore ? <DropdownMenuSeparator /> : null;

  if (action.submenu) {
    return (
      <>
        {separator}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {action.icon}
            {action.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {action.submenu.map((sub) => (
              <DropdownActionItem action={sub} key={sub.label} />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </>
    );
  }

  return (
    <>
      {separator}
      <DropdownMenuItem
        className={
          action.variant === "destructive"
            ? "text-destructive-foreground"
            : undefined
        }
        disabled={action.disabled === true}
        onClick={action.onClick}
      >
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    </>
  );
};

type TemplateDensity = "compact" | "comfortable";

const DENSITY_STORAGE_KEY = "stella.templates.density";

/** Persisted list density; defaults to compact for fast scanning. */
const readTemplateDensity = (): TemplateDensity =>
  localStorage.getItem(DENSITY_STORAGE_KEY) === "comfortable"
    ? "comfortable"
    : "compact";

const writeTemplateDensity = (density: TemplateDensity): void => {
  localStorage.setItem(DENSITY_STORAGE_KEY, density);
};

type TemplateRowProps = {
  template: TemplateItem;
  allTags: string[];
  categories: TemplateCategoryItem[];
  density: TemplateDensity;
  onAssignCategory: (
    templateId: string,
    categoryId: string | null,
  ) => Promise<void>;
  onCategoriesChanged: () => void;
  onSelect: () => void;
  onDeleted: () => void;
};

/** Stable hue (0–359) from a category id, so each category gets a consistent
 *  low-chroma tint and otherwise-identical rows become scannable. */
const categoryHue = (categoryId: string): number => {
  let hue = 0;
  for (const char of categoryId) {
    hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hue;
};

/** The template's initial in a rounded square, tinted by its category (the one
 *  accent per row). The hue rides in a CSS variable so the oklch classes can
 *  pick theme-appropriate lightness; uncategorized templates stay neutral. */
const TemplateMonogram = ({
  name,
  categoryId,
}: {
  name: string;
  categoryId: string | null;
}) => {
  const initial = (name.trim().at(0) ?? "?").toUpperCase();
  if (categoryId === null) {
    return (
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold">
        {initial}
      </div>
    );
  }
  // CSSProperties has no index signature for CSS custom properties, so widen
  // the binding rather than cast; --cat-hue feeds the oklch() classes.
  const style: CSSProperties & { "--cat-hue": string } = {
    "--cat-hue": String(categoryHue(categoryId)),
  };
  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[oklch(0.94_0.045_var(--cat-hue))] text-sm font-semibold text-[oklch(0.45_0.13_var(--cat-hue))] dark:bg-[oklch(0.32_0.05_var(--cat-hue))] dark:text-[oklch(0.85_0.11_var(--cat-hue))]"
      style={style}
    >
      {initial}
    </div>
  );
};

const TemplateRow = ({
  template,
  allTags,
  categories,
  density,
  onAssignCategory,
  onCategoriesChanged,
  onSelect,
  onDeleted,
}: TemplateRowProps) => {
  const categoryName =
    categories.find((category) => category.id === template.categoryId)?.name ??
    null;
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const canUpdateTemplate = usePermissions({ template: ["update"] });
  const canDeleteTemplate = usePermissions({ template: ["delete"] });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [useOpen, setUseOpen] = useState(false);
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    const response = await api
      .templates({
        templateId: template.id,
      })
      .delete();

    setDeleting(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.deleteFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("templates.templateDeleted"),
    });
    setDeleteOpen(false);
    onDeleted();
  };

  const rowActions: ContextMenuAction[] = [
    {
      // Redundant with the whole-row click, but makes "you can edit this"
      // explicit in both the right-click and ⋯ menus.
      label: t("common.edit"),
      icon: <SquarePenIcon />,
      onClick: onSelect,
    },
    {
      label: t("templates.useTemplate"),
      icon: <WandSparklesIcon />,
      onClick: () => setUseOpen(true),
    },
    {
      label: t("common.download"),
      icon: <DownloadIcon />,
      onClick: () =>
        void downloadTemplateSource(template.id, t("common.unexpectedError")),
    },
  ];
  if (canUpdateTemplate) {
    const categorySubmenu: ContextMenuAction[] = [
      categoryAction(
        t("common.uncategorized"),
        template.categoryId === null,
        () => void onAssignCategory(template.id, null),
      ),
    ];
    for (const category of categories) {
      categorySubmenu.push(
        categoryAction(
          category.name,
          template.categoryId === category.id,
          () => void onAssignCategory(template.id, category.id),
        ),
      );
    }
    categorySubmenu.push({
      label: t("templates.createCategory"),
      icon: <PlusIcon />,
      separatorBefore: true,
      onClick: () => setCreateCategoryOpen(true),
    });
    rowActions.push(
      {
        label: t("templates.addTag"),
        icon: <TagIcon />,
        onClick: () => setTagsOpen(true),
      },
      {
        label: t("templates.usageGuidance"),
        icon: <PencilLineIcon />,
        onClick: () => setGuidanceOpen(true),
      },
      {
        label: t("templates.moveToCategory"),
        icon: <FolderIcon />,
        submenu: categorySubmenu,
      },
    );
  }
  if (canDeleteTemplate) {
    rowActions.push({
      label: t("common.delete"),
      icon: <Trash2Icon />,
      onClick: () => setDeleteOpen(true),
      variant: "destructive",
    });
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(TEMPLATE_DRAG_MIME, template.id);
    e.dataTransfer.effectAllowed = "move";
  };

  // Trailing cluster — fixed width so it lines up across rows. `relative z-10`
  // keeps Use / ⋯ clickable above the row-wide open affordance (the name
  // button's stretched ::after). Opening the template is the whole-row click,
  // mirroring the clause list; Use (fill) stays an explicit CTA.
  const actions = (
    <div className="relative z-10 flex shrink-0 items-center gap-2">
      <Button onClick={() => setUseOpen(true)} size="xs" variant="outline">
        {t("templates.useTemplate")}
      </Button>
      <Tooltip
        content={template.authorName}
        render={<span className="inline-flex" />}
      >
        <UserAvatar
          className="size-6 shrink-0 text-[0.5625rem]"
          image={template.authorImage}
          name={template.authorName}
        />
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {rowActions.map((action) => (
            <DropdownActionItem action={action} key={action.label} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <li className="group">
      <ContextMenu actions={rowActions}>
        <div
          className={
            density === "compact"
              ? "hover:bg-muted/50 relative flex cursor-pointer items-center gap-3 px-4 py-2 transition-colors"
              : "hover:bg-muted/50 relative flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors"
          }
          draggable
          onDragStart={handleDragStart}
        >
          <TemplateMonogram
            categoryId={template.categoryId}
            name={template.name}
          />

          {density === "compact" ? (
            <>
              <button
                className="flex min-w-0 flex-1 items-baseline gap-2 text-start after:absolute after:inset-0"
                onClick={onSelect}
                type="button"
              >
                <span className="truncate text-sm font-medium">
                  {template.name}
                </span>
                {categoryName !== null && (
                  <span className="text-muted-foreground shrink-0 truncate text-xs">
                    {categoryName}
                  </span>
                )}
              </button>
              {actions}
            </>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-3">
                <button
                  className="flex min-w-0 flex-1 text-start after:absolute after:inset-0"
                  onClick={onSelect}
                  type="button"
                >
                  <span className="truncate text-sm font-medium">
                    {template.name}
                  </span>
                </button>
                {actions}
              </div>
              <RowDescription
                canUpdate={canUpdateTemplate}
                categoryName={categoryName}
                onDescribe={() => setGuidanceOpen(true)}
                template={template}
              />
              <RowStats lang={lang} template={template} />
            </div>
          )}
        </div>
      </ContextMenu>

      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("templates.confirmDelete")}
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

      <TemplateTagsDialog
        onOpenChange={setTagsOpen}
        open={tagsOpen}
        suggestions={allTags}
        template={template}
      />
      <TemplateGuidanceDialog
        onOpenChange={setGuidanceOpen}
        open={guidanceOpen}
        template={template}
      />
      <UseTemplateDialog
        onOpenChange={setUseOpen}
        open={useOpen}
        templateId={template.id}
        templateName={template.name}
      />
      <CategoryFormDialog
        onCreated={(category) =>
          void onAssignCategory(template.id, category.id)
        }
        onOpenChange={setCreateCategoryOpen}
        onSaved={onCategoriesChanged}
        open={createCategoryOpen}
      />
    </li>
  );
};

// ── Row metadata (muted, small) ──────────────────────

/** Localized via Intl so language names need no translation entries.
 *  Stored tags are server-validated, so `of()` cannot throw here. */
const languageDisplayName = (tag: string, uiLang: string): string =>
  new Intl.DisplayNames([uiLang], { type: "language" }).of(tag) ?? tag;

type RowStatsProps = {
  template: TemplateItem;
  lang: string;
};

// Always-visible secondary stats (comfortable density only): language chips
// plus field/usage counts and the last-updated time.
const RowStats = ({ template, lang }: RowStatsProps) => {
  const t = useTranslations();

  const segments: string[] = [
    t("templates.fieldCount", { count: template.fieldCount }),
  ];
  if (template.useCount > 0) {
    segments.push(t("templates.usedTimes", { count: template.useCount }));
  }
  if (template.lastUsedAt) {
    segments.push(
      t("templates.lastUsedAgo", {
        time: formatRelativeTime(template.lastUsedAt, lang),
      }),
    );
  }
  segments.push(
    t("templates.updatedAgo", {
      time: formatRelativeTime(template.updatedAt, lang),
    }),
  );

  return (
    <span className="text-muted-foreground flex items-center gap-2 text-xs tabular-nums">
      {template.languages.length > 0 && (
        <span className="flex items-center gap-1">
          {template.languages.map((tag) => (
            <span
              className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium uppercase"
              key={tag}
              title={languageDisplayName(tag, lang)}
            >
              {tag}
            </span>
          ))}
        </span>
      )}
      <span className="truncate">{segments.join(" · ")}</span>
    </span>
  );
};

type RowDescriptionProps = {
  template: TemplateItem;
  categoryName: string | null;
  canUpdate: boolean;
  onDescribe: () => void;
};

// Category + "when to use" guidance (comfortable density only). Falls back to
// a quiet nudge to add guidance when none is set and the user can edit.
const RowDescription = ({
  template,
  categoryName,
  canUpdate,
  onDescribe,
}: RowDescriptionProps) => {
  const t = useTranslations();

  const guidance = template.whenToUse?.trim() ?? "";

  // Editable "when to use": a pencil-led button that opens the guidance dialog.
  // `relative z-10` keeps it clickable above the row-wide open affordance, so
  // editing guidance is distinct from opening the template. When the user can't
  // edit, show plain text (or nothing if there is no guidance).
  const detail = (() => {
    if (canUpdate) {
      return (
        <button
          className="hover:text-foreground relative z-10 inline-flex min-w-0 items-center gap-1 underline-offset-2 hover:underline"
          onClick={onDescribe}
          type="button"
        >
          <PencilLineIcon className="size-3 shrink-0" />
          <span className="truncate">
            {guidance === "" ? t("templates.describeWhenToUse") : guidance}
          </span>
        </button>
      );
    }
    if (guidance !== "") {
      return <span className="truncate">{guidance}</span>;
    }
    return null;
  })();

  if (categoryName === null && detail === null) {
    return null;
  }

  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      {categoryName !== null && (
        <span className="text-foreground shrink-0 font-medium">
          {categoryName}
        </span>
      )}
      {categoryName !== null && detail !== null && <span aria-hidden>·</span>}
      {detail}
    </span>
  );
};

// ── Tags dialog ──────────────────────────────────────

const MAX_TAG_SUGGESTIONS = 6;

type TemplateTagsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: TemplateItem;
  suggestions: string[];
};

const TemplateTagsDialog = ({
  open,
  onOpenChange,
  template,
  suggestions,
}: TemplateTagsDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {/* Mount only while open so each open re-seeds from the template. */}
    {open ? (
      <TemplateTagsDialogBody
        onOpenChange={onOpenChange}
        suggestions={suggestions}
        template={template}
      />
    ) : null}
  </Dialog>
);

const TemplateTagsDialogBody = ({
  onOpenChange,
  template,
  suggestions,
}: Omit<TemplateTagsDialogProps, "open">) => {
  const t = useTranslations();
  const invalidateTemplates = useInvalidateTemplates();
  const [tags, setTags] = useState<string[]>(template.tags ?? []);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const addTag = (value: string) => {
    const tag = value.trim();
    if (!tag || tags.includes(tag)) {
      setInput("");
      return;
    }
    setTags((current) => [...current, tag]);
    setInput("");
  };

  const matchingSuggestions = suggestions
    .filter(
      (tag) =>
        !tags.includes(tag) &&
        tag.toLowerCase().includes(input.trim().toLowerCase()),
    )
    .slice(0, MAX_TAG_SUGGESTIONS);

  const handleSave = async () => {
    setSaving(true);
    const response = await api.templates({ templateId: template.id }).post({
      tags,
    });
    setSaving(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.saveFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    invalidateTemplates();
    onOpenChange(false);
  };

  return (
    <DialogPopup className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{t("templates.addTag")}</DialogTitle>
      </DialogHeader>
      <DialogPanel className="grid gap-3">
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                className="bg-muted text-foreground flex items-center gap-1 rounded-full py-0.5 ps-2 pe-1 text-xs font-medium"
                key={tag}
              >
                {tag}
                <button
                  aria-label={t("common.remove")}
                  className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                  onClick={() =>
                    setTags((current) => current.filter((x) => x !== tag))
                  }
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <Input
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag(input);
            }
          }}
          placeholder={t("templates.tagPlaceholder")}
          value={input}
        />

        {matchingSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {matchingSuggestions.map((tag) => (
              <button
                className="bg-muted text-muted-foreground hover:text-foreground rounded-full px-2 py-0.5 text-xs font-medium transition-colors"
                key={tag}
                onClick={() => addTag(tag)}
                type="button"
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={saving}
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

// ── Usage-guidance dialog (when to use / when not to) ─

type TemplateGuidanceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: TemplateItem;
};

const TemplateGuidanceDialog = ({
  open,
  onOpenChange,
  template,
}: TemplateGuidanceDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {/* Mount only while open so each open re-seeds from the template. */}
    {open ? (
      <TemplateGuidanceDialogBody
        onOpenChange={onOpenChange}
        template={template}
      />
    ) : null}
  </Dialog>
);

const MAX_TEMPLATE_LANGUAGES = 4;

const TemplateGuidanceDialogBody = ({
  onOpenChange,
  template,
}: Omit<TemplateGuidanceDialogProps, "open">) => {
  const t = useTranslations();
  const invalidateTemplates = useInvalidateTemplates();
  const [whenToUse, setWhenToUse] = useState(template.whenToUse ?? "");
  const [whenNotToUse, setWhenNotToUse] = useState(template.whenNotToUse ?? "");
  const [languages, setLanguages] = useState<string[]>(template.languages);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const response = await api.templates({ templateId: template.id }).post({
      whenToUse: whenToUse.trim() || null,
      whenNotToUse: whenNotToUse.trim() || null,
      languages,
    });
    setSaving(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.saveFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    invalidateTemplates();
    onOpenChange(false);
  };

  return (
    <DialogPopup className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t("templates.usageGuidance")}</DialogTitle>
      </DialogHeader>
      <DialogPanel className="grid gap-4">
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="template-when-to-use">
            {t("templates.whenToUse")}
          </label>
          <Textarea
            className="min-h-[60px]"
            id="template-when-to-use"
            maxLength={10_000}
            onChange={(e) => setWhenToUse(e.target.value)}
            placeholder={t("templates.whenToUsePlaceholder")}
            value={whenToUse}
          />
        </div>
        <div className="grid gap-1.5">
          <label
            className="text-sm font-medium"
            htmlFor="template-when-not-to-use"
          >
            {t("templates.whenNotToUse")}
          </label>
          <Textarea
            className="min-h-[60px]"
            id="template-when-not-to-use"
            maxLength={10_000}
            onChange={(e) => setWhenNotToUse(e.target.value)}
            placeholder={t("templates.whenNotToUsePlaceholder")}
            value={whenNotToUse}
          />
        </div>
        <TemplateLanguagesField languages={languages} onChange={setLanguages} />
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={saving}
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

// ── Languages field (multi-select + free BCP-47 entry) ─

type TemplateLanguagesFieldProps = {
  languages: string[];
  onChange: (languages: string[]) => void;
};

const TemplateLanguagesField = ({
  languages,
  onChange,
}: TemplateLanguagesFieldProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const [input, setInput] = useState("");

  const addLanguage = (value: string) => {
    const tag = value.trim();
    setInput("");
    if (!tag || languages.length >= MAX_TEMPLATE_LANGUAGES) {
      return;
    }
    const exists = languages.some(
      (existing) => existing.toLowerCase() === tag.toLowerCase(),
    );
    if (exists) {
      return;
    }
    onChange([...languages, tag]);
  };

  const quickPicks = supportedLanguages.filter(
    (tag) =>
      !languages.some(
        (existing) => existing.toLowerCase() === tag.toLowerCase(),
      ),
  );

  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium" htmlFor="template-languages">
        {t("templates.languages")}
      </label>

      {languages.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {languages.map((tag) => (
            <span
              className="bg-muted text-foreground flex items-center gap-1 rounded-full py-0.5 ps-2 pe-1 text-xs font-medium"
              key={tag}
            >
              {languageDisplayName(tag, lang)}
              <span className="text-muted-foreground uppercase">{tag}</span>
              <button
                aria-label={t("common.remove")}
                className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                onClick={() => onChange(languages.filter((x) => x !== tag))}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Input
        disabled={languages.length >= MAX_TEMPLATE_LANGUAGES}
        id="template-languages"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addLanguage(input);
          }
        }}
        placeholder={t("templates.languagesPlaceholder")}
        value={input}
      />

      {languages.length < MAX_TEMPLATE_LANGUAGES && (
        <div className="flex flex-wrap gap-1">
          {quickPicks.map((tag) => (
            <button
              className="bg-muted text-muted-foreground hover:text-foreground rounded-full px-2 py-0.5 text-xs font-medium transition-colors"
              key={tag}
              onClick={() => addLanguage(tag)}
              type="button"
            >
              {languageDisplayName(tag, lang)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Shared category assignment ───────────────────────

/** Assigns (or clears, when `categoryId` is null) a template's category.
 *  Mirrors the tag/guidance saves: same POST endpoint, single-field body. */
const useAssignTemplateCategory = () => {
  const t = useTranslations();
  const invalidateTemplates = useInvalidateTemplates();

  return async (templateId: string, categoryId: string | null) => {
    const response = await api.templates({ templateId }).post({
      categoryId:
        categoryId === null ? null : toSafeId<"templateCategory">(categoryId),
    });

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.saveFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    invalidateTemplates();
  };
};

// ── Shared invalidation ──────────────────────────────

const useInvalidateTemplates = () => {
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  return () => {
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      })
      .catch(() => {
        /* fire-and-forget */
      });
  };
};
