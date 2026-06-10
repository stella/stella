import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  DownloadIcon,
  LayoutTemplateIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PlusIcon,
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
  DropdownMenuTrigger,
} from "@stll/ui/components/menu";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { ContextMenu } from "@/components/context-menu";
import type { ContextMenuAction } from "@/components/context-menu";
import { UserAvatar } from "@/components/user-avatar";
import { usePermissions } from "@/hooks/use-permissions";
import { supportedLanguages, useI18nStore } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { TemplateCategorySidebar } from "@/routes/_protected.knowledge/-components/template-category-sidebar";
import type { TemplateCategoryItem } from "@/routes/_protected.knowledge/-components/template-category-sidebar";
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [discovering, setDiscovering] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

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
    <div className="flex min-h-0 flex-1">
      <TemplateCategorySidebar
        categories={categories}
        onCategoriesChanged={onCategoriesChanged}
        onSelect={onCategorySelect}
        selectedId={selectedCategoryId}
      />

      <div className="flex min-h-0 flex-1 flex-col border-s">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-muted-foreground text-sm">
              {String(visibleTemplates.length)}
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
                key={template.id}
                onDeleted={onDeleted}
                onSelect={() => onSelect(template)}
                onTagClick={(tag) =>
                  setTagFilter((current) => (current === tag ? null : tag))
                }
                tagFilter={tagFilter}
                template={template}
              />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

// ── Row ──────────────────────────────────────────────

const MAX_VISIBLE_TAGS = 3;

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

type TemplateRowProps = {
  template: TemplateItem;
  allTags: string[];
  tagFilter: string | null;
  onTagClick: (tag: string) => void;
  onSelect: () => void;
  onDeleted: () => void;
};

const TemplateRow = ({
  template,
  allTags,
  tagFilter,
  onTagClick,
  onSelect,
  onDeleted,
}: TemplateRowProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const canUpdateTemplate = usePermissions({ template: ["update"] });
  const canDeleteTemplate = usePermissions({ template: ["delete"] });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [useOpen, setUseOpen] = useState(false);

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

  const contextActions: ContextMenuAction[] = [
    {
      label: t("templates.useTemplate"),
      icon: <WandSparklesIcon />,
      onClick: () => setUseOpen(true),
    },
  ];
  if (canUpdateTemplate) {
    contextActions.push(
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
    );
  }
  if (canDeleteTemplate) {
    contextActions.push({
      label: t("common.delete"),
      icon: <Trash2Icon />,
      onClick: () => setDeleteOpen(true),
      variant: "destructive",
    });
  }

  const tags = template.tags ?? [];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTagCount = tags.length - visibleTags.length;

  return (
    <li className="group">
      <ContextMenu actions={contextActions}>
        <div className="flex items-center gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button
              className="flex min-w-0 items-center gap-3 text-start hover:opacity-80"
              onClick={onSelect}
              type="button"
            >
              <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                <LayoutTemplateIcon className="text-muted-foreground size-4" />
              </div>
              <span className="truncate text-sm font-medium">
                {template.name}
              </span>
            </button>

            {tags.length > 0 && (
              <span className="flex shrink-0 items-center gap-1">
                {visibleTags.map((tag) => (
                  <button
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                      tag === tagFilter
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground hover:text-foreground",
                    )}
                    key={tag}
                    onClick={() => onTagClick(tag)}
                    type="button"
                  >
                    {tag}
                  </button>
                ))}
                {hiddenTagCount > 0 && (
                  <span className="text-muted-foreground text-[11px]">
                    +{String(hiddenTagCount)}
                  </span>
                )}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <Button
              onClick={() => setUseOpen(true)}
              size="xs"
              variant="outline"
            >
              {t("templates.useTemplate")}
            </Button>
            <RowMeta
              canUpdate={canUpdateTemplate}
              lang={lang}
              onDescribe={() => setGuidanceOpen(true)}
              template={template}
            />

            <span title={template.authorName ?? undefined}>
              <UserAvatar
                className="size-6 shrink-0 text-[0.5625rem]"
                image={template.authorImage}
                name={template.authorName}
              />
            </span>

            {(canUpdateTemplate || canDeleteTemplate) && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button size="icon-xs" variant="ghost" />}
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    onClick={() =>
                      void downloadTemplateSource(
                        template.id,
                        t("common.unexpectedError"),
                      )
                    }
                  >
                    <DownloadIcon />
                    {t("common.download")}
                  </DropdownMenuItem>
                  {canUpdateTemplate && (
                    <>
                      <DropdownMenuItem onClick={() => setTagsOpen(true)}>
                        <TagIcon />
                        {t("templates.addTag")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setGuidanceOpen(true)}>
                        <PencilLineIcon />
                        {t("templates.usageGuidance")}
                      </DropdownMenuItem>
                    </>
                  )}
                  {canDeleteTemplate && (
                    <DropdownMenuItem
                      className="text-destructive-foreground"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2Icon />
                      {t("common.delete")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
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
    </li>
  );
};

// ── Row metadata (muted, small) ──────────────────────

/** Localized via Intl so language names need no translation entries.
 *  Stored tags are server-validated, so `of()` cannot throw here. */
const languageDisplayName = (tag: string, uiLang: string): string =>
  new Intl.DisplayNames([uiLang], { type: "language" }).of(tag) ?? tag;

type RowMetaProps = {
  template: TemplateItem;
  lang: string;
  canUpdate: boolean;
  onDescribe: () => void;
};

const RowMeta = ({ template, lang, canUpdate, onDescribe }: RowMetaProps) => {
  const t = useTranslations();

  const segments: string[] = [
    t("templates.fieldCount", { count: template.fieldCount }),
    t("templates.updatedAgo", {
      time: formatRelativeTime(template.updatedAt, lang),
    }),
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

  const showNudge = canUpdate && !template.whenToUse;

  return (
    <span className="text-muted-foreground hidden items-center gap-1 text-xs sm:flex">
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
      <span className="whitespace-nowrap">{segments.join(" · ")}</span>
      {showNudge && (
        <>
          <span>{"·"}</span>
          <button
            className="hover:text-foreground whitespace-nowrap underline-offset-2 hover:underline"
            onClick={onDescribe}
            type="button"
          >
            {t("templates.describeWhenToUse")}
          </button>
        </>
      )}
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
            maxLength={2000}
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
            maxLength={2000}
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
