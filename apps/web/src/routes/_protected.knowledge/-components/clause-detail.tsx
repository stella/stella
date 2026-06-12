import { useCallback, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  StarIcon,
  Trash2Icon,
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import {
  toAPIError,
  userErrorFromThrown,
  userErrorMessage,
} from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { ClauseBody } from "@/routes/_protected.knowledge/-components/clause-body";
import { diffClauseBodies } from "@/routes/_protected.knowledge/-components/clause-diff";
import type { ParagraphDiff } from "@/routes/_protected.knowledge/-components/clause-diff";
import { ClauseDiffView } from "@/routes/_protected.knowledge/-components/clause-diff-view";
import { ClauseEditor } from "@/routes/_protected.knowledge/-components/clause-editor";
import type { ClauseParagraph } from "@/routes/_protected.knowledge/-components/clause-editor-types";
import {
  clauseDetailOptions,
  knowledgeKeys,
} from "@/routes/_protected.knowledge/-queries";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";

// ── Types ────────────────────────────────────────────

/** Narrows JSONB `unknown` to ClauseParagraph[].
 *  Validates the first element only (sample check);
 *  sufficient for trusted API data. */
const isClauseParagraphs = (value: unknown): value is ClauseParagraph[] => {
  if (!Array.isArray(value)) {
    return false;
  }
  if (value.length === 0) {
    return true;
  }
  const first: unknown = value[0];
  return (
    typeof first === "object" &&
    first !== null &&
    "text" in first &&
    typeof first.text === "string"
  );
};

type VariantItem = {
  id: string;
  label: string;
  body: unknown;
  sortOrder: number;
  createdAt: Date;
};

type VersionItem = {
  id: string;
  version: number;
  createdAt: Date;
};

type ClauseDetail = {
  id: string;
  title: string;
  categoryId: string | null;
  description: string | null;
  usageNotes: string | null;
  language: string | null;
  body: ClauseParagraph[];
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  variants: VariantItem[];
  versions: VersionItem[];
};

type CategoryOption = {
  id: string;
  name: string;
};

type ClauseDetailViewProps = {
  organizationId: string;
  clauseId: string;
  categories: CategoryOption[];
  onBack: () => void;
  onDeleted: () => void;
};

// ── Main Component ───────────────────────────────────

export const ClauseDetailView = ({
  organizationId,
  clauseId,
  categories,
  onBack,
  onDeleted,
}: ClauseDetailViewProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const canEditClause = usePermissions({ clause: ["update"] });
  const canDeleteClause = usePermissions({ clause: ["delete"] });
  const detailQuery = useQuery(clauseDetailOptions(organizationId, clauseId));

  // SAFETY: The API returns body as ClauseParagraph[]
  // but Eden types it as unknown due to JSONB.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  const detail = detailQuery.data as unknown as ClauseDetail | undefined;

  const refreshDetail = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.clauses.detail(organizationId, clauseId),
    });
  }, [clauseId, organizationId, queryClient]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {detailQuery.isPending && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("clauses.loading")}
          </p>
        </div>
      )}

      {detailQuery.isError && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("clauses.loadFailed")}
          </p>
        </div>
      )}

      {detail && (
        <DetailContent
          canDelete={canDeleteClause}
          canEdit={canEditClause}
          categories={categories}
          clauseId={clauseId}
          detail={detail}
          onBack={onBack}
          onDeleted={onDeleted}
          onRefresh={refreshDetail}
        />
      )}
    </div>
  );
};

// ── Detail Content ───────────────────────────────────

const DetailContent = ({
  detail,
  clauseId,
  categories,
  canEdit,
  canDelete,
  onBack,
  onDeleted,
  onRefresh,
}: {
  detail: ClauseDetail;
  clauseId: string;
  categories: CategoryOption[];
  canEdit: boolean;
  canDelete: boolean;
  onBack: () => void;
  onDeleted: () => void;
  onRefresh: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <div className="mx-auto w-full max-w-2xl overflow-y-auto p-6">
      <ClauseHeader
        canDelete={canDelete}
        canEdit={canEdit}
        categories={categories}
        clauseId={clauseId}
        detail={detail}
        onBack={onBack}
        onDeleted={onDeleted}
        onRefresh={onRefresh}
      />

      <p className="text-muted-foreground mt-2 text-sm">
        {t("clauses.version", {
          version: String(detail.currentVersion),
        })}
        {" \u00b7 "}
        {format.dateTime(new Date(detail.createdAt), {
          dateStyle: "medium",
        })}
      </p>

      <div className="mt-3 grid gap-3">
        <ClauseInlineTextField
          canEdit={canEdit}
          clauseId={clauseId}
          field="description"
          label={t("common.description")}
          placeholder={t("clauses.descriptionPlaceholder")}
          onRefresh={onRefresh}
          value={detail.description}
        />
        <ClauseInlineTextField
          canEdit={canEdit}
          clauseId={clauseId}
          field="language"
          inputProps={{ maxLength: 10, className: "w-40" }}
          label={t("common.language")}
          placeholder={t("clauses.languagePlaceholder")}
          onRefresh={onRefresh}
          value={detail.language}
        />
      </div>

      <Tabs className="mt-6" defaultValue="body">
        <TabsList variant="underline">
          <TabsTab value="body">{t("clauses.body")}</TabsTab>
          <TabsTab value="variants">{t("clauses.variants")}</TabsTab>
          <TabsTab value="history">{t("common.history")}</TabsTab>
        </TabsList>

        <TabsPanel value="body">
          <ClauseBodyEditor
            canEdit={canEdit}
            clauseId={clauseId}
            detail={detail}
            onRefresh={onRefresh}
          />
          <ClauseUsageNotesField
            canEdit={canEdit}
            clauseId={clauseId}
            onRefresh={onRefresh}
            value={detail.usageNotes}
          />
        </TabsPanel>

        <TabsPanel value="variants">
          <VariantsTab
            clauseId={clauseId}
            onRefresh={onRefresh}
            variants={detail.variants}
          />
        </TabsPanel>

        <TabsPanel value="history">
          <HistoryTab
            clauseId={clauseId}
            currentBody={detail.body}
            onRefresh={onRefresh}
            versions={detail.versions}
          />
        </TabsPanel>
      </Tabs>
    </div>
  );
};

// \u2500\u2500 Header (back, inline title, category, delete) \u2500\u2500\u2500\u2500

const ClauseHeader = ({
  detail,
  clauseId,
  categories,
  canEdit,
  canDelete,
  onBack,
  onDeleted,
  onRefresh,
}: {
  detail: ClauseDetail;
  clauseId: string;
  categories: CategoryOption[];
  canEdit: boolean;
  canDelete: boolean;
  onBack: () => void;
  onDeleted: () => void;
  onRefresh: () => void;
}) => {
  const t = useTranslations();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(detail.title);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const saveTitle = useCallback(async () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (trimmed === "" || trimmed === detail.title) {
      setTitleDraft(detail.title);
      return;
    }

    const response = await api.clauses({ clauseId }).post({ title: trimmed });

    if (response.error) {
      setTitleDraft(detail.title);
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

    onRefresh();
  }, [clauseId, detail.title, titleDraft, t, onRefresh]);

  const saveCategory = useCallback(
    async (value: string) => {
      const response = await api.clauses({ clauseId }).post({
        categoryId: value === "" ? null : toSafeId<"clauseCategory">(value),
      });

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

      onRefresh();
    },
    [clauseId, t, onRefresh],
  );

  const deleteClause = useMutation({
    mutationFn: async () => {
      const response = await api.clauses({ clauseId }).delete();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      stellaToast.add({
        type: "success",
        title: t("clauses.clauseDeleted"),
      });
      setDeleteOpen(false);
      onDeleted();
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
    <div className="flex items-center gap-2">
      <Button
        aria-label={t("common.back")}
        onClick={onBack}
        size="icon-sm"
        variant="ghost"
      >
        <ArrowLeftIcon />
      </Button>

      {editingTitle && canEdit ? (
        <InlineEdit
          className="flex-1"
          inputClassName="flex-1 text-base"
          onCancel={() => {
            setTitleDraft(detail.title);
            setEditingTitle(false);
          }}
          onChange={setTitleDraft}
          onCommit={() => {
            void saveTitle();
          }}
          value={titleDraft}
        />
      ) : (
        <button
          className="flex-1 truncate text-start text-lg font-semibold disabled:cursor-default"
          disabled={!canEdit}
          onClick={() => {
            setTitleDraft(detail.title);
            setEditingTitle(true);
          }}
          type="button"
        >
          {detail.title}
        </button>
      )}

      {canEdit && (
        <Select
          disabled={!canEdit}
          onValueChange={(val) => {
            void saveCategory(val ?? "");
          }}
          value={detail.categoryId ?? ""}
        >
          <SelectTrigger className="h-8 w-40 text-sm">
            <SelectValue placeholder={t("common.uncategorized")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("common.uncategorized")}</SelectItem>
            {categories.map((cat) => (
              <SelectItem key={cat.id} value={cat.id}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}

      {canDelete && (
        <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
          <Button
            aria-label={t("clauses.deleteClause")}
            onClick={() => setDeleteOpen(true)}
            size="icon-sm"
            variant="ghost"
          >
            <Trash2Icon className="size-4" />
          </Button>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("clauses.deleteClause")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("clauses.confirmDeleteClause")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>
                {t("common.cancel")}
              </AlertDialogClose>
              <Button
                disabled={deleteClause.isPending}
                onClick={() => {
                  deleteClause.mutate();
                }}
                variant="destructive"
              >
                {t("common.delete")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </div>
  );
};

// \u2500\u2500 Inline editable body (WYSIWYG, autosave) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ClauseBodyEditor = ({
  detail,
  clauseId,
  canEdit,
  onRefresh,
}: {
  detail: ClauseDetail;
  clauseId: string;
  canEdit: boolean;
  onRefresh: () => void;
}) => {
  const t = useTranslations();

  const saveBody = useCallback(
    async (body: ClauseParagraph[]) => {
      const response = await api.clauses({ clauseId }).post({ body });

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

      onRefresh();
    },
    [clauseId, t, onRefresh],
  );

  const debouncedSave = useDebouncedCallback((body: ClauseParagraph[]) => {
    void saveBody(body);
  }, 1200);

  if (!canEdit) {
    return (
      <div className="mt-4 rounded-lg border p-4">
        <ClauseBody paragraphs={detail.body} />
      </div>
    );
  }

  return (
    <div className="mt-4">
      <ClauseEditor
        content={detail.body}
        onBlur={(body) => {
          debouncedSave.cancel();
          void saveBody(body);
        }}
        onChange={debouncedSave}
        title={detail.title}
        usageNotes={detail.usageNotes ?? undefined}
      />
    </div>
  );
};

// ── Inline metadata fields (autosave) ────────────────

/** Short single-line metadata field (description, language).
 *  Commits the trimmed value on blur, sending `null` when empty,
 *  mirroring the modal's `field.trim() || null` shape. */
const ClauseInlineTextField = ({
  field,
  value,
  label,
  placeholder,
  clauseId,
  canEdit,
  onRefresh,
  inputProps,
}: {
  field: "description" | "language";
  value: string | null;
  label: string;
  placeholder: string;
  clauseId: string;
  canEdit: boolean;
  onRefresh: () => void;
  inputProps?: { maxLength?: number; className?: string };
}) => {
  const t = useTranslations();
  const [draft, setDraft] = useState(value ?? "");

  const commit = useCallback(async () => {
    const next = draft.trim() || null;
    if (next === (value ?? null)) {
      return;
    }

    const response = await api.clauses({ clauseId }).post({ [field]: next });

    if (response.error) {
      setDraft(value ?? "");
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

    onRefresh();
  }, [clauseId, draft, field, value, t, onRefresh]);

  if (!canEdit) {
    if (!value) {
      return null;
    }
    return (
      <div className="grid gap-1">
        <span className="text-muted-foreground text-xs font-medium">
          {label}
        </span>
        <p className="text-muted-foreground text-sm">{value}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium" htmlFor={`clause-${field}`}>
        {label}
      </label>
      <Input
        className={inputProps?.className}
        id={`clause-${field}`}
        maxLength={inputProps?.maxLength}
        onBlur={() => {
          void commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        value={draft}
      />
    </div>
  );
};

/** Multi-line usage notes field. Autosaves on a debounce while
 *  typing and flushes on blur, matching the body editor's pattern. */
const ClauseUsageNotesField = ({
  value,
  clauseId,
  canEdit,
  onRefresh,
}: {
  value: string | null;
  clauseId: string;
  canEdit: boolean;
  onRefresh: () => void;
}) => {
  const t = useTranslations();
  const [draft, setDraft] = useState(value ?? "");

  const save = useCallback(
    async (text: string) => {
      const next = text.trim() || null;
      if (next === (value ?? null)) {
        return;
      }

      const response = await api
        .clauses({ clauseId })
        .post({ usageNotes: next });

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

      onRefresh();
    },
    [clauseId, value, t, onRefresh],
  );

  const debouncedSave = useDebouncedCallback((text: string) => {
    void save(text);
  }, 1200);

  if (!canEdit) {
    if (!value) {
      return null;
    }
    return (
      <div className="mt-3">
        <p className="text-muted-foreground text-xs font-medium">
          {t("clauses.usageNotes")}
        </p>
        <p className="text-muted-foreground mt-1 text-sm">{value}</p>
      </div>
    );
  }

  return (
    <div className="mt-3 grid gap-1.5">
      <label className="text-sm font-medium" htmlFor="clause-usage-notes">
        {t("clauses.usageNotes")}
      </label>
      <Textarea
        className="min-h-[60px]"
        id="clause-usage-notes"
        onBlur={() => {
          debouncedSave.cancel();
          void save(draft);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          debouncedSave(e.target.value);
        }}
        placeholder={t("clauses.usageNotesPlaceholder")}
        value={draft}
      />
    </div>
  );
};

// ── Variants Tab ─────────────────────────────────────

const VariantsTab = ({
  clauseId,
  variants,
  onRefresh,
}: {
  clauseId: string;
  variants: VariantItem[];
  onRefresh: () => void;
}) => {
  const t = useTranslations();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="mt-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-muted-foreground text-sm">
          {String(variants.length)}
        </span>
        <Button onClick={() => setAddOpen(true)} size="sm" variant="outline">
          <PlusIcon />
          {t("clauses.addVariant")}
        </Button>
      </div>

      {variants.length === 0 && (
        <p className="text-muted-foreground py-4 text-center text-sm">
          {t("clauses.noVariants")}
        </p>
      )}

      {variants.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {variants.map((variant, index) => (
            <VariantRow
              clauseId={clauseId}
              index={index}
              key={variant.id}
              onChanged={onRefresh}
              variant={variant}
              variants={variants}
            />
          ))}
        </ul>
      )}

      <VariantFormDialog
        clauseId={clauseId}
        onOpenChange={setAddOpen}
        onSaved={onRefresh}
        open={addOpen}
      />
    </div>
  );
};

/** Reverse of the create form's split: join paragraph text back into
 *  the plain-text textarea representation. */
const variantBodyToText = (body: unknown): string => {
  const paragraphs = isClauseParagraphs(body) ? body : [];
  return paragraphs.map((p) => p.text).join("\n");
};

const VariantRow = ({
  variant,
  variants,
  index,
  clauseId,
  onChanged,
}: {
  variant: VariantItem;
  variants: VariantItem[];
  index: number;
  clauseId: string;
  onChanged: () => void;
}) => {
  const t = useTranslations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [reordering, setReordering] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    const response = await api
      .clauses({ clauseId })
      .variants({ variantId: variant.id })
      .delete();

    setDeleting(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.deleteFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("clauses.variantDeleted"),
    });
    setDeleteOpen(false);
    onChanged();
  }, [clauseId, variant.id, t, onChanged]);

  const handlePromote = useCallback(async () => {
    const body = isClauseParagraphs(variant.body) ? variant.body : [];
    if (body.length === 0) {
      return;
    }

    setPromoting(true);
    // Reuse the clause update endpoint: a body change bumps
    // currentVersion and writes a clauseVersions snapshot, so the
    // promotion stays auditable and revertable from history.
    const response = await api.clauses({ clauseId }).post({ body });

    setPromoting(false);

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

    stellaToast.add({
      type: "success",
      title: t("clauses.variantPromoted"),
    });
    setPromoteOpen(false);
    onChanged();
  }, [clauseId, variant.body, t, onChanged]);

  const handleReorder = useCallback(
    async (direction: "up" | "down") => {
      const neighborIndex = direction === "up" ? index - 1 : index + 1;
      const neighbor = variants.at(neighborIndex);
      if (!neighbor) {
        return;
      }

      setReordering(true);
      // Swap sortOrder with the neighbor; the list query orders by
      // sortOrder asc so the rows visually exchange places.
      const [first, second] = await Promise.all([
        api
          .clauses({ clauseId })
          .variants({ variantId: variant.id })
          .post({ sortOrder: neighbor.sortOrder }),
        api
          .clauses({ clauseId })
          .variants({ variantId: neighbor.id })
          .post({ sortOrder: variant.sortOrder }),
      ]);

      setReordering(false);

      const failure = first.error ?? second.error;
      if (failure) {
        stellaToast.add({
          type: "error",
          title: t("clauses.saveFailed"),
          description: userErrorMessage(failure, t("common.unexpectedError")),
        });
        return;
      }

      onChanged();
    },
    [clauseId, index, variant.id, variant.sortOrder, variants, t, onChanged],
  );

  const body = isClauseParagraphs(variant.body) ? variant.body : [];
  const canMoveUp = index > 0;
  const canMoveDown = index < variants.length - 1;

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{variant.label}</span>
        <div className="flex items-center gap-1">
          <Button
            aria-label={t("common.moveUp")}
            disabled={!canMoveUp || reordering}
            onClick={() => {
              void handleReorder("up");
            }}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronUpIcon />
          </Button>
          <Button
            aria-label={t("common.moveDown")}
            disabled={!canMoveDown || reordering}
            onClick={() => {
              void handleReorder("down");
            }}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronDownIcon />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-xs" variant="ghost" />}
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <PencilIcon />
                {t("common.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPromoteOpen(true)}>
                <StarIcon />
                {t("clauses.useAsMainBody")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive-foreground"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2Icon />
                {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {body.length > 0 && (
        <div className="bg-muted/30 mt-2 rounded border p-3">
          <ClauseBody paragraphs={body} />
        </div>
      )}

      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("common.deleteConfirmDescription", {
                name: variant.label,
              })}
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

      <AlertDialog onOpenChange={setPromoteOpen} open={promoteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("clauses.useAsMainBody")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("clauses.confirmUseAsMainBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={promoting}
              onClick={() => {
                void handlePromote();
              }}
            >
              {t("clauses.useAsMainBody")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <VariantFormDialog
        clauseId={clauseId}
        onOpenChange={setEditOpen}
        onSaved={onChanged}
        open={editOpen}
        variant={variant}
      />
    </li>
  );
};

// ── Variant Form Dialog ──────────────────────────────

const VariantFormDialog = ({
  clauseId,
  open,
  onOpenChange,
  onSaved,
  variant,
}: {
  clauseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  variant?: VariantItem;
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {/* Mount only while open so each open re-seeds from `variant`
        (edit) or resets to blank (create) without an effect, matching
        ClauseFormDialog. */}
    {open ? (
      <VariantFormDialogBody
        clauseId={clauseId}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
        variant={variant}
      />
    ) : null}
  </Dialog>
);

const VariantFormDialogBody = ({
  clauseId,
  onOpenChange,
  onSaved,
  variant,
}: {
  clauseId: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  variant: VariantItem | undefined;
}) => {
  const t = useTranslations();
  const isEdit = !!variant;
  const [label, setLabel] = useState(() => variant?.label ?? "");
  const [bodyText, setBodyText] = useState(() =>
    variant ? variantBodyToText(variant.body) : "",
  );
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!label.trim()) {
      return;
    }

    setSaving(true);

    const body = bodyText.split("\n").map((line) => ({ text: line }));
    const payload = { label: label.trim(), body };

    const response =
      variant !== undefined
        ? await api
            .clauses({ clauseId })
            .variants({ variantId: variant.id })
            .post(payload)
        : await api.clauses({ clauseId }).variants.put(payload);

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

    stellaToast.add({
      type: "success",
      title: isEdit ? t("clauses.variantUpdated") : t("clauses.variantCreated"),
    });

    onOpenChange(false);
    onSaved();
  }, [clauseId, isEdit, variant, label, bodyText, t, onOpenChange, onSaved]);

  return (
    <DialogPopup className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>
          {isEdit ? t("clauses.editVariant") : t("clauses.addVariant")}
        </DialogTitle>
      </DialogHeader>
      <DialogPanel className="grid gap-4">
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="variant-label">
            {t("clauses.variantLabel")}
          </label>
          <Input
            id="variant-label"
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("clauses.variantLabelPlaceholder")}
            value={label}
          />
        </div>
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="variant-body">
            {t("clauses.body")}
          </label>
          <Textarea
            className="min-h-[100px]"
            id="variant-body"
            onChange={(e) => setBodyText(e.target.value)}
            value={bodyText}
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={saving || !label.trim()}
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

// ── History Tab ──────────────────────────────────────

const HistoryTab = ({
  clauseId,
  currentBody,
  versions,
  onRefresh,
}: {
  clauseId: string;
  currentBody: ClauseParagraph[];
  versions: VersionItem[];
  onRefresh: () => void;
}) => {
  const t = useTranslations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<ParagraphDiff[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleVersionClick = useCallback(
    async (versionId: string) => {
      if (selectedId === versionId) {
        setSelectedId(null);
        setDiffResult(null);
        return;
      }

      setSelectedId(versionId);
      setLoading(true);
      setDiffResult(null);

      const response = await api
        .clauses({ clauseId })
        .versions({ versionId })
        .get();

      setLoading(false);

      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("clauses.loadFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        setSelectedId(null);
        return;
      }

      const data = response.data;
      if (data instanceof Response) {
        setSelectedId(null);
        return;
      }

      const oldBody = isClauseParagraphs(data.body) ? data.body : [];
      const diff = diffClauseBodies(oldBody, currentBody);
      setDiffResult(diff);
    },
    [clauseId, currentBody, selectedId, t],
  );

  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground mt-4 py-4 text-center text-sm">
        {t("clauses.noVersions")}
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <p className="text-muted-foreground text-sm">
        {t("clauses.selectVersionToCompare")}
      </p>
      <div className="rounded-lg border">
        <ul className="divide-y">
          {versions.map((ver) => (
            <VersionRow
              clauseId={clauseId}
              isSelected={selectedId === ver.id}
              key={ver.id}
              onRestored={onRefresh}
              onToggleDiff={() => {
                void handleVersionClick(ver.id);
              }}
              version={ver}
            />
          ))}
        </ul>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
        </div>
      )}

      {diffResult && (
        <div className="rounded-lg border p-4">
          <h4 className="mb-3 text-sm font-medium">
            {t("clauses.compareWithCurrent")}
          </h4>
          {diffResult.every((d) => d.status === "equal") ? (
            <p className="text-muted-foreground text-sm">
              {t("clauses.noChanges")}
            </p>
          ) : (
            <ClauseDiffView diffs={diffResult} />
          )}
        </div>
      )}
    </div>
  );
};

const VersionRow = ({
  version,
  clauseId,
  isSelected,
  onToggleDiff,
  onRestored,
}: {
  version: VersionItem;
  clauseId: string;
  isSelected: boolean;
  onToggleDiff: () => void;
  onRestored: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    const response = await api
      .clauses({ clauseId })
      .versions({ versionId: version.id })
      .restore.post();

    setRestoring(false);

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

    stellaToast.add({
      type: "success",
      title: t("clauses.versionRestored"),
    });
    setRestoreOpen(false);
    onRestored();
  }, [clauseId, version.id, t, onRestored]);

  return (
    <li className="flex items-center gap-2 px-2">
      <button
        className={cn(
          "flex flex-1 items-center justify-between",
          "px-2 py-3 text-sm transition-colors",
          "hover:bg-muted/50 rounded",
          isSelected && "bg-muted",
        )}
        onClick={onToggleDiff}
        type="button"
      >
        <span className="font-medium">
          {t("clauses.version", {
            version: String(version.version),
          })}
        </span>
        <span className="text-muted-foreground">
          {format.dateTime(new Date(version.createdAt), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      </button>
      <AlertDialog onOpenChange={setRestoreOpen} open={restoreOpen}>
        <Button
          aria-label={t("clauses.restoreVersion")}
          onClick={() => setRestoreOpen(true)}
          size="icon-xs"
          variant="ghost"
        >
          <RotateCcwIcon />
        </Button>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("clauses.restoreVersion")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("clauses.confirmRestoreVersion")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={restoring}
              onClick={() => {
                void handleRestore();
              }}
            >
              {t("clauses.restoreVersion")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
};
