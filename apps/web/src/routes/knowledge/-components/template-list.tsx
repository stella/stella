import { useState } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { compareByLocale } from "@stll/collation";
import { LANGUAGES, toLanguageCode } from "@stll/locales";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import type { ContextMenuAction } from "@stll/ui/context-menu";
import {
  Dialog,
  DialogFormState,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import {
  CheckIcon,
  DownloadIcon,
  PencilLineIcon,
  PlusIcon,
  SquarePenIcon,
  TagIcon,
  Trash2Icon,
  AiActionIcon,
  XIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import Tooltip from "@/components/tooltip";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { memberKnowledgeActions } from "@/features/knowledge/member/member-knowledge";
import { TemplateLibraryView } from "@/features/knowledge/views/templates/template-list-view";
import {
  languageDisplayName,
  TemplateRowView,
} from "@/features/knowledge/views/templates/template-row-view";
import type { TemplateDensity } from "@/features/knowledge/views/templates/template-row-view";
import type {
  KnowledgeTemplate,
  TemplatesSource,
} from "@/features/knowledge/views/templates/templates-seam";
import { usePermissions } from "@/hooks/use-permissions";
import { useI18nStore } from "@/i18n/i18n-store";
import type { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { isDocxFile } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { toSafeId } from "@/lib/safe-id";
import { CategoryMobileFilterBar } from "@/routes/knowledge/-components/category-sidebar";
import {
  CategoryFormDialog,
  TemplateCategorySidebar,
  useTemplateCategoryLabels,
} from "@/routes/knowledge/-components/template-category-sidebar";
import type { TemplateCategoryItem } from "@/routes/knowledge/-components/template-category-sidebar";
import { TEMPLATE_DRAG_MIME } from "@/routes/knowledge/-components/template-drag";
import { TemplateUpload } from "@/routes/knowledge/-components/template-upload";
import { UseTemplateDialog } from "@/routes/knowledge/-components/use-template-dialog";

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

/** The member library keeps full category rows for the category tools. */
type MemberTemplatesSource = TemplatesSource & {
  categories: TemplateCategoryItem[];
};

type TemplateListProps = {
  source: MemberTemplatesSource;
  onCategorySelect: (id: string | null) => void;
  onCategoriesChanged: () => void;
  onCreateBlank: () => void;
  onDiscovered: (file: File, schema: DiscoverData) => void;
  onLoadMore: () => void;
  onSelect: (template: KnowledgeTemplate) => void;
  onDeleted: () => void;
  /** A tab after the list title leading to the published catalogue. */
  catalogueTab?: ReactNode;
};

/** The organization's template library: the shared list view with the member
 *  category tools, upload, and row actions in its slots. */
export const TemplateList = ({
  catalogueTab,
  source,
  onCategorySelect,
  onCategoriesChanged,
  onCreateBlank,
  onDiscovered,
  onLoadMore,
  onSelect,
  onDeleted,
}: TemplateListProps) => {
  const t = useTranslations();
  const canCreateTemplate = usePermissions({ template: ["create"] });
  const templateActions = useMemberTemplateActions();
  const assignCategory = useAssignTemplateCategory();
  const [discovering, setDiscovering] = useState(false);
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
  const categoryLabels = useTemplateCategoryLabels();
  const { categories, selectedCategoryId } = source;

  const discover = async (file: File) => {
    if (!isDocxFile(file)) {
      notifyUserError(undefined, t("templates.invalidFileType"));
      return;
    }

    setDiscovering(true);
    // `finally` rather than a straight-line reset: the caller hands this
    // promise to `detached`, so a rejected request would leave the dropzone
    // stuck in its discovering state with nothing to clear it.
    const response = await templateActions.discover(file).finally(() => {
      setDiscovering(false);
    });

    if (response.error) {
      notifyUserError(
        toAPIError(response.error),
        t("templates.discoveryFailed"),
        {
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        },
      );
      return;
    }

    const { data } = response;
    if (data instanceof Response) {
      notifyUserError(undefined, t("templates.discoveryFailed"));
      return;
    }

    onDiscovered(file, data);
  };

  const dropFile = (file: File) => {
    if (!isDocxFile(file)) {
      notifyUserError(undefined, t("templates.invalidFileType"));
      return;
    }
    // Errors are surfaced as toasts inside discover
    detached(discover(file), "template-list.discover-dropped");
  };

  return (
    <TemplateLibraryView
      actions={{
        loadMore: onLoadMore,
        dropFile: canCreateTemplate ? dropFile : undefined,
      }}
      catalogueTab={catalogueTab}
      emptyState={
        <TemplateUpload
          onCreateBlank={onCreateBlank}
          onDiscovered={onDiscovered}
        />
      }
      mobileFilters={(filter) => (
        <CategoryMobileFilterBar
          canCreate={canCreateTemplate}
          categories={categories}
          extraFilters={filter.tags.map((tag) => ({
            id: tag,
            label: tag,
            active: filter.selectedTag === tag,
            icon: <TagIcon className="size-3.5" />,
            onSelect: () =>
              filter.selectTag(filter.selectedTag === tag ? null : tag),
          }))}
          labels={categoryLabels}
          onCreateCategory={() => setCreateCategoryOpen(true)}
          onSelect={onCategorySelect}
          onSelectAll={() => {
            onCategorySelect(null);
            filter.selectTag(null);
          }}
          selectedId={selectedCategoryId}
        />
      )}
      renderRow={(template, row) => (
        <MemberTemplateRow
          allTags={row.allTags}
          categories={categories}
          density={row.density}
          key={template.id}
          onAssignCategory={assignCategory}
          onCategoriesChanged={onCategoriesChanged}
          onDeleted={onDeleted}
          onSelect={() => onSelect(template)}
          template={template}
        />
      )}
      sidebar={(filter) => (
        <TemplateCategorySidebar
          categories={categories}
          onAssignCategory={assignCategory}
          onCategoriesChanged={onCategoriesChanged}
          onSelect={onCategorySelect}
          onSelectTag={filter.selectTag}
          selectedId={selectedCategoryId}
          selectedTag={filter.selectedTag}
          tags={filter.tags}
        />
      )}
      source={source}
      toolbar={
        canCreateTemplate && (
          <Button disabled={discovering} onClick={onCreateBlank} size="sm">
            <PlusIcon />
            {discovering ? t("common.loading") : t("templates.newTemplate")}
          </Button>
        )
      }
    >
      <CategoryFormDialog
        onOpenChange={setCreateCategoryOpen}
        onSaved={onCategoriesChanged}
        open={createCategoryOpen}
      />
    </TemplateLibraryView>
  );
};

// ── Row ──────────────────────────────────────────────

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

type MemberTemplateRowProps = {
  template: KnowledgeTemplate;
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

/** One library row: the shared row view with the member's actions and the
 *  dialogs behind them. */
const MemberTemplateRow = ({
  template,
  allTags,
  categories,
  density,
  onAssignCategory,
  onCategoriesChanged,
  onSelect,
  onDeleted,
}: MemberTemplateRowProps) => {
  const categoryName =
    categories.find((category) => category.id === template.categoryId)?.name ??
    null;
  const t = useTranslations();
  const templateActions = useMemberTemplateActions();
  const canUseTemplate = usePermissions({ template: ["use"] });
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
    const response = await templateActions.remove(template.id);

    setDeleting(false);

    if (response.error) {
      notifyUserError(toAPIError(response.error), t("templates.deleteFailed"), {
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

  /** Opens the audited presigned URL of the source DOCX. */
  const downloadSource = async () => {
    const sourceUrl = await templateActions.readSourceUrl(template.id);
    if (sourceUrl === null) {
      notifyUserError(undefined, t("common.unexpectedError"));
      return;
    }
    openIsolatedWindow(sourceUrl);
  };

  const rowActions: ContextMenuAction[] = [
    {
      // Redundant with the whole-row click, but makes "you can edit this"
      // explicit in both the right-click and ⋯ menus.
      label: t("common.edit"),
      icon: <SquarePenIcon />,
      onClick: onSelect,
    },
  ];
  if (canUseTemplate) {
    rowActions.push({
      label: t("templates.useTemplate"),
      icon: <AiActionIcon />,
      onClick: () => setUseOpen(true),
    });
  }
  rowActions.push({
    label: t("common.download"),
    icon: <DownloadIcon />,
    onClick: () =>
      detached(downloadSource(), "template-list.download-template-source"),
  });
  if (canUpdateTemplate) {
    const categorySubmenu: ContextMenuAction[] = [
      categoryAction(
        t("common.uncategorized"),
        template.categoryId === null,
        () =>
          detached(
            onAssignCategory(template.id, null),
            "template-list.assign-category",
          ),
      ),
    ];
    for (const category of categories) {
      categorySubmenu.push(
        categoryAction(category.name, template.categoryId === category.id, () =>
          detached(
            onAssignCategory(template.id, category.id),
            "template-list.assign-category",
          ),
        ),
      );
    }
    categorySubmenu.push({
      label: t("common.createCategory"),
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
        icon: <EntityKindIcon kind="folder" />,
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

  return (
    <TemplateRowView
      actions={{
        open: onSelect,
        use: canUseTemplate ? () => setUseOpen(true) : undefined,
        describe: canUpdateTemplate ? () => setGuidanceOpen(true) : undefined,
        menu: rowActions,
        dragStart: handleDragStart,
      }}
      categoryName={categoryName}
      density={density}
      template={template}
    >
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
                detached(handleDelete(), "template-list.delete");
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
      {canUseTemplate && (
        <UseTemplateDialog
          onOpenChange={setUseOpen}
          open={useOpen}
          templateId={template.id}
          templateName={template.name}
        />
      )}
      <CategoryFormDialog
        onCreated={(category) =>
          detached(
            onAssignCategory(template.id, category.id),
            "template-list.assign-category",
          )
        }
        onOpenChange={setCreateCategoryOpen}
        onSaved={onCategoriesChanged}
        open={createCategoryOpen}
      />
    </TemplateRowView>
  );
};

// ── Tags dialog ──────────────────────────────────────

const MAX_TAG_SUGGESTIONS = 6;

type TemplateTagsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: KnowledgeTemplate;
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
  const templateActions = useMemberTemplateActions();
  const [tags, setTags] = useState<string[]>(() =>
    optionalArray(template.tags),
  );
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
    const response = await templateActions.update(template.id, {
      tags,
    });
    setSaving(false);

    if (response.error) {
      notifyUserError(toAPIError(response.error), t("templates.saveFailed"), {
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    templateActions.invalidateTemplates();
    onOpenChange(false);
  };

  return (
    <DialogPopup className="sm:max-w-sm">
      <DialogFormState
        dirty={
          JSON.stringify(tags) !==
            JSON.stringify(optionalArray(template.tags)) || input !== ""
        }
        onDiscard={() => {
          setTags(optionalArray(template.tags));
          setInput("");
        }}
      />
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
                <Tooltip
                  content={t("common.remove")}
                  render={
                    <button
                      aria-label={t("common.remove")}
                      className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                      onClick={() =>
                        setTags((current) => current.filter((x) => x !== tag))
                      }
                      type="button"
                    />
                  }
                >
                  <XIcon className="size-3" />
                </Tooltip>
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
                className="bg-muted text-muted-foreground hover:text-foreground rounded-full px-2 py-0.5 text-xs font-medium"
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
            detached(handleSave(), "template-list.save");
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
  template: KnowledgeTemplate;
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
  const templateActions = useMemberTemplateActions();
  const [whenToUse, setWhenToUse] = useState(template.whenToUse ?? "");
  const [whenNotToUse, setWhenNotToUse] = useState(template.whenNotToUse ?? "");
  const [languages, setLanguages] = useState<string[]>(template.languages);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const response = await templateActions.update(template.id, {
      whenToUse: whenToUse.trim() || null,
      whenNotToUse: whenNotToUse.trim() || null,
      languages,
    });
    setSaving(false);

    if (response.error) {
      notifyUserError(toAPIError(response.error), t("templates.saveFailed"), {
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    templateActions.invalidateTemplates();
    onOpenChange(false);
  };

  return (
    <DialogPopup className="sm:max-w-lg">
      <DialogFormState
        dirty={
          whenToUse !== (template.whenToUse ?? "") ||
          whenNotToUse !== (template.whenNotToUse ?? "") ||
          JSON.stringify(languages) !== JSON.stringify(template.languages)
        }
        onDiscard={() => {
          setWhenToUse(template.whenToUse ?? "");
          setWhenNotToUse(template.whenNotToUse ?? "");
          setLanguages(template.languages);
        }}
      />
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
            detached(handleSave(), "template-list.save");
          }}
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};

// ── Languages field (searchable multi-select over ISO 639-1) ─

type TemplateLanguagesFieldProps = {
  languages: string[];
  onChange: (languages: string[]) => void;
};

type LanguagePick = {
  code: string;
  label: string;
};

const TemplateLanguagesField = ({
  languages,
  onChange,
}: TemplateLanguagesFieldProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);

  const selectedCodes = new Set(languages);
  // Offer the full ISO 639-1 living-language list, minus already-picked codes,
  // sorted by the localized label so search and scanning are predictable.
  const compareLabel = compareByLocale(lang);
  const options: LanguagePick[] = LANGUAGES.flatMap((language) =>
    selectedCodes.has(language.code)
      ? []
      : [
          {
            code: language.code,
            label: languageDisplayName(language.code, lang),
          },
        ],
  ).toSorted((a, b) => compareLabel(a.label, b.label));

  const atLimit = languages.length >= MAX_TEMPLATE_LANGUAGES;

  const addLanguage = (pick: LanguagePick | null) => {
    if (!pick || atLimit) {
      return;
    }
    const code = toLanguageCode(pick.code);
    if (!code || selectedCodes.has(code)) {
      return;
    }
    onChange([...languages, code]);
  };

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
              <Tooltip
                content={t("common.remove")}
                render={
                  <button
                    aria-label={t("common.remove")}
                    className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                    onClick={() => onChange(languages.filter((x) => x !== tag))}
                    type="button"
                  />
                }
              >
                <XIcon className="size-3" />
              </Tooltip>
            </span>
          ))}
        </div>
      )}

      {!atLimit && (
        <Combobox<LanguagePick>
          autoHighlight
          isItemEqualToValue={(a, b) => a.code === b.code}
          items={options}
          itemToStringLabel={(item) => item.label}
          onValueChange={addLanguage}
          value={null}
        >
          <ComboboxInput
            id="template-languages"
            placeholder={t("templates.languagesPlaceholder")}
          />
          <ComboboxPopup>
            <ComboboxList>
              {(item: LanguagePick) => (
                <ComboboxItem key={item.code} value={item}>
                  {item.label}
                  <span className="text-muted-foreground ms-2 uppercase">
                    {item.code}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
            <ComboboxEmpty>
              {t("translate.dialog.noLanguagesFound")}
            </ComboboxEmpty>
          </ComboboxPopup>
        </Combobox>
      )}
    </div>
  );
};

// ── Shared category assignment ───────────────────────

/** Assigns (or clears, when `categoryId` is null) a template's category.
 *  Mirrors the tag/guidance saves: same POST endpoint, single-field body. */
const useAssignTemplateCategory = () => {
  const t = useTranslations();
  const templateActions = useMemberTemplateActions();

  return async (templateId: string, categoryId: string | null) => {
    const response = await templateActions.update(templateId, {
      categoryId:
        categoryId === null ? null : toSafeId<"templateCategory">(categoryId),
    });

    if (response.error) {
      notifyUserError(toAPIError(response.error), t("templates.saveFailed"), {
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    templateActions.invalidateTemplates();
  };
};

// ── Member template writes ───────────────────────────

const useMemberTemplateActions = () => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  return memberKnowledgeActions.useTemplateActions(activeOrganizationId);
};
