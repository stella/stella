import { useCallback, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
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
import { ClauseBody } from "@/routes/_protected.knowledge/-components/clause-body";
import { diffClauseBodies } from "@/routes/_protected.knowledge/-components/clause-diff";
import type { ParagraphDiff } from "@/routes/_protected.knowledge/-components/clause-diff";
import { ClauseDiffView } from "@/routes/_protected.knowledge/-components/clause-diff-view";
import { ClauseFormDialog } from "@/routes/_protected.knowledge/-components/clause-form-dialog";
import type { BlockDirectiveKind } from "@/routes/_protected.knowledge/-components/paragraph-rendering";
import {
  clauseDetailOptions,
  knowledgeKeys,
} from "@/routes/_protected.knowledge/-queries";

// ── Types ────────────────────────────────────────────

type ClauseRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
};

type ClauseParagraph = {
  text: string;
  style?: string;
  level?: number;
  runs?: ClauseRun[];
  isDirective?: boolean;
  directiveKind?: BlockDirectiveKind;
  directiveExpression?: string;
};

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
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // SAFETY: The API returns body as ClauseParagraph[]
  // but Eden types it as unknown due to JSONB.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  const detail = detailQuery.data as unknown as ClauseDetail | undefined;

  const refreshDetail = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.clauses.detail(organizationId, clauseId),
    });
  }, [clauseId, organizationId, queryClient]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeftIcon />
          {t("clauses.backToList")}
        </Button>

        {detail && (
          <div className="flex gap-1">
            {canEditClause && (
              <Button
                onClick={() => setEditOpen(true)}
                size="sm"
                variant="outline"
              >
                {t("common.edit")}
              </Button>
            )}
            {canDeleteClause && (
              <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
                <Button
                  onClick={() => setDeleteOpen(true)}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2Icon className="size-4" />
                </Button>
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("clauses.deleteClause")}
                    </AlertDialogTitle>
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
        )}
      </div>

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
          categories={categories}
          clauseId={clauseId}
          detail={detail}
          onRefresh={refreshDetail}
        />
      )}

      {detail && (
        <ClauseFormDialog
          categories={categories}
          initial={{
            ...detail,
            bodyParagraphs: detail.body,
          }}
          onOpenChange={setEditOpen}
          onSaved={refreshDetail}
          open={editOpen}
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
  onRefresh,
}: {
  detail: ClauseDetail;
  clauseId: string;
  categories: CategoryOption[];
  onRefresh: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  const categoryName = detail.categoryId
    ? categories.find((c) => c.id === detail.categoryId)?.name
    : null;

  return (
    <div className="mx-auto w-full max-w-2xl overflow-y-auto p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold">{detail.title}</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {categoryName ?? t("common.uncategorized")}
          {" \u00b7 "}
          {t("clauses.version", {
            version: String(detail.currentVersion),
          })}
          {" \u00b7 "}
          {format.dateTime(new Date(detail.createdAt), {
            dateStyle: "medium",
          })}
        </p>
        {detail.description && (
          <p className="text-muted-foreground mt-2 text-sm">
            {detail.description}
          </p>
        )}
      </div>

      <Tabs defaultValue="body">
        <TabsList variant="underline">
          <TabsTab value="body">{t("clauses.body")}</TabsTab>
          <TabsTab value="variants">{t("clauses.variants")}</TabsTab>
          <TabsTab value="history">{t("clauses.history")}</TabsTab>
        </TabsList>

        <TabsPanel value="body">
          <div className="mt-4 rounded-lg border p-4">
            <ClauseBody paragraphs={detail.body} />
          </div>
          {detail.usageNotes && (
            <div className="mt-3">
              <p className="text-muted-foreground text-xs font-medium">
                {t("clauses.usageNotes")}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                {detail.usageNotes}
              </p>
            </div>
          )}
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
            versions={detail.versions}
          />
        </TabsPanel>
      </Tabs>
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
          {variants.map((variant) => (
            <VariantRow
              clauseId={clauseId}
              key={variant.id}
              onChanged={onRefresh}
              variant={variant}
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

const VariantRow = ({
  variant,
  clauseId,
  onChanged,
}: {
  variant: VariantItem;
  clauseId: string;
  onChanged: () => void;
}) => {
  const t = useTranslations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  const body = isClauseParagraphs(variant.body) ? variant.body : [];

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{variant.label}</span>
        <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-xs" variant="ghost" />}
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                className="text-destructive-foreground"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2Icon />
                {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
      </div>
      {body.length > 0 && (
        <div className="bg-muted/30 mt-2 rounded border p-3">
          <ClauseBody paragraphs={body} />
        </div>
      )}
    </li>
  );
};

// ── Variant Form Dialog ──────────────────────────────

const VariantFormDialog = ({
  clauseId,
  open,
  onOpenChange,
  onSaved,
}: {
  clauseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) => {
  const t = useTranslations();
  const [label, setLabel] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!label.trim()) {
      return;
    }

    setSaving(true);

    const body = bodyText.split("\n").map((line) => ({ text: line }));

    const response = await api
      .clauses({ clauseId })
      .variants.put({ label: label.trim(), body });

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
      title: t("clauses.variantCreated"),
    });

    setLabel("");
    setBodyText("");
    onOpenChange(false);
    onSaved();
  }, [clauseId, label, bodyText, t, onOpenChange, onSaved]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("clauses.addVariant")}</DialogTitle>
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
    </Dialog>
  );
};

// ── History Tab ──────────────────────────────────────

const HistoryTab = ({
  clauseId,
  currentBody,
  versions,
}: {
  clauseId: string;
  currentBody: ClauseParagraph[];
  versions: VersionItem[];
}) => {
  const t = useTranslations();
  const format = useFormatter();
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
            <li key={ver.id}>
              <button
                className={cn(
                  "flex w-full items-center justify-between",
                  "px-4 py-3 text-sm transition-colors",
                  "hover:bg-muted/50",
                  selectedId === ver.id && "bg-muted",
                )}
                onClick={() => {
                  void handleVersionClick(ver.id);
                }}
                type="button"
              >
                <span className="font-medium">
                  {t("clauses.version", {
                    version: String(ver.version),
                  })}
                </span>
                <span className="text-muted-foreground">
                  {format.dateTime(new Date(ver.createdAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </button>
            </li>
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
