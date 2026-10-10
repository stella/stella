import { useCallback, useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { CLAUSE_DIRECTIVES_INVALID_CODE } from "@stll/api-contract";
import { compareByLocale } from "@stll/collation";
import { displayLanguageName, LANGUAGES, toLanguageCode } from "@stll/locales";
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
  ChevronDownIcon,
  ChevronUpIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  StarIcon,
  Trash2Icon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Loader } from "@stll/ui/loader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@stll/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/tabs";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { InlineEdit } from "@/components/inline-edit";
import type { ClauseParagraph } from "@/components/templates/clause-editor-types";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { useI18nStore } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { APIError, toAPIError, unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  clauseDetailOptions,
  knowledgeKeys,
  invalidateTemplateClauseSources,
} from "@/lib/knowledge/queries";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import type { ClauseEditorReviewStatus } from "@/routes/knowledge/-components/clause-ai-tracked-changes";
import { ClauseBody } from "@/routes/knowledge/-components/clause-body";
import { diffClauseBodies } from "@/routes/knowledge/-components/clause-diff";
import type { ParagraphDiff } from "@/routes/knowledge/-components/clause-diff";
import { ClauseDiffView } from "@/routes/knowledge/-components/clause-diff-view";
import type { ClauseRewrite } from "@/routes/knowledge/-components/clause-editor";
import { ClauseEditor } from "@/routes/knowledge/-components/clause-editor";
import type { ClauseBodyWrite } from "@/routes/knowledge/-components/use-clause-body-save";
import { useClauseBodySave } from "@/routes/knowledge/-components/use-clause-body-save";
import { useClauseFieldSave } from "@/routes/knowledge/-components/use-clause-field-save";
import { useClauseNavStore } from "@/stores/knowledge/clause-nav-store";

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
  createdAt: string;
};

type VersionItem = {
  id: string;
  version: number;
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
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

  const detail = detailQuery.data;

  const refreshDetail = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.clauses.detail(organizationId, clauseId),
      }),
      "clause-detail.invalidate",
    );
  };

  return (
    // Scroll on the full-width pane so the scrollbar tracks the right edge
    // (next to the inspector rail), not the centered max-w content column.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
          organizationId={organizationId}
          key={clauseId}
          onBack={onBack}
          onDeleted={onDeleted}
          onRefresh={refreshDetail}
        />
      )}
    </div>
  );
};

// ── Detail Content ───────────────────────────────────

export type ClauseHead = {
  body: ClauseParagraph[];
  currentVersion: number;
  updatedAt: string;
};
export type ClauseDetailTransport = {
  save: (write: ClauseBodyWrite) => Promise<ClauseHead>;
  read: () => Promise<ClauseParagraph[]>;
  restore: (
    versionId: string,
    expectedBody: ClauseParagraph[],
  ) => Promise<ClauseHead>;
  promote: (
    body: ClauseParagraph[],
    expectedBody: ClauseParagraph[],
  ) => Promise<ClauseHead>;
  rewrite?: ClauseRewrite | undefined;
};

export const DetailContent = ({
  detail,
  organizationId,
  transport,
  clauseId,
  categories,
  canEdit,
  canDelete,
  onBack,
  onDeleted,
  onRefresh,
}: {
  detail: ClauseDetail;
  organizationId: string;
  transport?: ClauseDetailTransport;
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
  const queryClient = useQueryClient();
  const options = clauseDetailOptions(organizationId, clauseId);
  const resolvedTransport =
    transport ??
    ({
      save: async (write: ClauseBodyWrite) => {
        const saved = unwrapEden(await api.clauses({ clauseId }).post(write));
        return { ...saved, body: write.body };
      },
      read: async () => unwrapEden(await api.clauses({ clauseId }).get()).body,
      restore: async (versionId: string, expectedBody: ClauseParagraph[]) =>
        unwrapEden(
          await api
            .clauses({ clauseId })
            .versions({ versionId })
            .restore.post({ expectedBody }),
        ),
      promote: async (
        body: ClauseParagraph[],
        expectedBody: ClauseParagraph[],
      ) => {
        const saved = unwrapEden(
          await api
            .clauses({ clauseId })
            .post({ body, expectedBody, snapshotVersion: true }),
        );
        return { ...saved, body };
      },
      rewrite: undefined,
    } satisfies ClauseDetailTransport);
  const [directiveRefusal, setDirectiveRefusal] = useState(false);
  const cacheHead = async (head: ClauseHead) => {
    setDirectiveRefusal(false);
    if (head.currentVersion !== detail.currentVersion) {
      await invalidateTemplateClauseSources(queryClient, organizationId);
    }
    await queryClient.cancelQueries({
      queryKey: options.queryKey,
      exact: true,
    });
    queryClient.setQueryData(options.queryKey, (previous) =>
      previous ? { ...previous, ...head } : previous,
    );
    onRefresh();
  };
  const reportBodyError = (error: unknown) => {
    if (APIError.is(error) && error.code === CLAUSE_DIRECTIVES_INVALID_CODE) {
      setDirectiveRefusal(true);
      return;
    }
    getAnalytics().captureError(error);
    notifyUserError(error, t("clauses.saveFailed"), {
      description: userErrorFromThrown(error, t("common.unexpectedError")),
    });
  };
  const bodySave = useClauseBodySave({
    initialBody: detail.body,
    persist: async (write) => {
      const saved = await resolvedTransport.save(write);
      await cacheHead(saved);
      return saved;
    },
    readHead: async () => {
      const body = await resolvedTransport.read();
      queryClient.setQueryData(options.queryKey, (previous) =>
        previous ? { ...previous, body } : previous,
      );
      return body;
    },
    onError: reportBodyError,
  });
  const reviewStatus = bodySave.reviewStatus;
  const bodyActionAllowed = () => {
    if (reviewStatus === "resolved") {
      return true;
    }
    stellaToast.add({
      type: "info",
      title: t("clauses.reviewBeforeBodyAction"),
    });
    return false;
  };

  const promoteBody = async (body: ClauseParagraph[]) => {
    if (!bodyActionAllowed()) {
      return false;
    }
    return bodySave.sequenceHead(async (expectedBody) => {
      const head = await resolvedTransport.promote(body, expectedBody);
      await cacheHead(head);
      return head.body;
    });
  };

  const restoreBody = async (versionId: string) => {
    if (!bodyActionAllowed()) {
      return false;
    }
    return bodySave.sequenceHead(async (expectedBody) => {
      const head = await resolvedTransport.restore(versionId, expectedBody);
      await cacheHead(head);
      return head.body;
    });
  };

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <ClauseHeader
        canDelete={canDelete}
        canEdit={canEdit}
        categories={categories}
        clauseId={clauseId}
        detail={detail}
        dirtySinceVersion={bodySave.dirty}
        reviewStatus={reviewStatus}
        onBack={onBack}
        onDeleted={onDeleted}
        onRefresh={onRefresh}
        onSaveVersion={bodySave.snapshot}
        onFlushBody={bodySave.flush}
      />

      {bodySave.conflict.status === "choice" && (
        <div className="mt-4 rounded-lg border p-4" role="alert">
          <p className="font-medium">{t("clauses.saveConflictTitle")}</p>
          <p className="text-muted-foreground text-sm">
            {t("clauses.saveConflictDescription")}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              onClick={() => {
                detached(bodySave.keepMine(), "clause-detail.keep-mine");
              }}
            >
              {t("clauses.keepMyText")}
            </Button>
            <Button onClick={bodySave.takeTheirs} variant="outline">
              {t("clauses.takeTheirText")}
            </Button>
          </div>
        </div>
      )}

      <p className="text-muted-foreground mt-2 text-sm">
        {t("common.versionLabel", {
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
        <ClauseLanguageField
          canEdit={canEdit}
          clauseId={clauseId}
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

        <TabsPanel keepMounted value="body">
          <ClauseBodyEditor
            canEdit={canEdit}
            detail={detail}
            bodySave={bodySave}
            rewrite={resolvedTransport.rewrite}
          />
          {directiveRefusal && (
            <p role="alert" className="text-destructive mt-2 text-sm">
              {t("clauses.directivesInvalid")}
            </p>
          )}
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
            onRefresh={() => {
              onRefresh();
              detached(
                invalidateTemplateClauseSources(queryClient, organizationId),
                "clause-detail.variant-invalidate",
              );
            }}
            onPromote={promoteBody}
            variants={detail.variants}
          />
        </TabsPanel>

        <TabsPanel value="history">
          <HistoryTab
            clauseId={clauseId}
            currentBody={bodySave.body}
            onRestore={restoreBody}
            versions={detail.versions}
          />
        </TabsPanel>
      </Tabs>
    </div>
  );
};

// \u2500\u2500 Header (inline title, category, delete) \u2500\u2500\u2500\u2500

type ClauseLeaveState = "closed" | "confirm" | "failed" | "review";
const ClauseLeaveDialog = ({
  leaveDialog,
  savingVersion,
  reviewStatus,
  onClose,
  onBack,
  leaveWithoutVersion,
  saveVersionAndLeave,
}: {
  leaveDialog: ClauseLeaveState;
  savingVersion: boolean;
  reviewStatus: ClauseEditorReviewStatus;
  onClose: () => void;
  onBack: () => void;
  leaveWithoutVersion: () => Promise<void>;
  saveVersionAndLeave: () => Promise<void>;
}) => {
  const t = useTranslations();
  const descriptions = {
    closed: t("clauses.unsavedVersionLeaveConfirm"),
    confirm: t("clauses.unsavedVersionLeaveConfirm"),
    failed: t("clauses.saveFailedLeaveDescription"),
    review: t("clauses.reviewBeforeLeaving"),
  } satisfies Record<ClauseLeaveState, string>;
  const description = descriptions[leaveDialog];
  return (
    <AlertDialog
      open={leaveDialog !== "closed"}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("common.confirmAction")}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("common.goBackToEditing")}
          </AlertDialogClose>
          {(leaveDialog === "failed" || leaveDialog === "review") && (
            <Button onClick={onBack} variant="destructive">
              {t("clauses.leaveAndDiscard")}
            </Button>
          )}
          {leaveDialog !== "review" && (
            <Button
              onClick={() => {
                detached(
                  leaveWithoutVersion(),
                  "clause-detail.leave-without-version",
                );
              }}
              variant="ghost"
              disabled={savingVersion}
            >
              {t("clauses.leaveWithoutVersion")}
            </Button>
          )}
          <Button
            disabled={savingVersion || reviewStatus !== "resolved"}
            onClick={() => {
              detached(
                saveVersionAndLeave(),
                "clause-detail.save-version-and-leave",
              );
            }}
          >
            {t("clauses.saveVersionAndLeave")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};

const ClauseHeader = ({
  detail,
  clauseId,
  categories,
  canEdit,
  canDelete,
  dirtySinceVersion,
  reviewStatus,
  onBack,
  onDeleted,
  onRefresh,
  onSaveVersion,
  onFlushBody,
}: {
  detail: ClauseDetail;
  clauseId: string;
  categories: CategoryOption[];
  canEdit: boolean;
  canDelete: boolean;
  dirtySinceVersion: boolean;
  reviewStatus: ClauseEditorReviewStatus;
  onBack: () => void;
  onDeleted: () => void;
  onRefresh: () => void;
  onSaveVersion: () => Promise<boolean>;
  onFlushBody: () => Promise<boolean>;
}) => {
  const t = useTranslations();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(detail.title);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveDialog, setLeaveDialog] = useState<ClauseLeaveState>("closed");
  const [savingVersion, setSavingVersion] = useState(false);
  const setNavOpen = useClauseNavStore((s) => s.setOpen);
  const setNavName = useClauseNavStore((s) => s.setName);
  const clearNav = useClauseNavStore((s) => s.clear);

  const saveVersion = useCallback(async () => {
    if (reviewStatus !== "resolved") {
      return false;
    }
    setSavingVersion(true);
    const clean = await onSaveVersion();
    setSavingVersion(false);
    return clean;
  }, [reviewStatus, onSaveVersion]);

  const saveVersionAndLeave = useCallback(async () => {
    const ok = await saveVersion();
    if (ok) {
      onBack();
      return;
    }
    setLeaveDialog("failed");
  }, [saveVersion, onBack]);

  // Offer a version snapshot for edits made since the last publication.
  const handleBack = useCallback(() => {
    if (reviewStatus !== "resolved") {
      setLeaveDialog("review");
      return;
    }
    if (dirtySinceVersion) {
      setLeaveDialog("confirm");
      return;
    }
    onBack();
  }, [dirtySinceVersion, reviewStatus, onBack]);

  const leaveWithoutVersion = useCallback(async () => {
    if (reviewStatus === "pending") {
      setLeaveDialog("review");
      return;
    }
    if (await onFlushBody()) {
      onBack();
      return;
    }
    setLeaveDialog("failed");
  }, [reviewStatus, onBack, onFlushBody]);

  // Publish the open clause to the breadcrumb (Knowledge › Vzorová ustanovení ›
  // Name) and wire its list crumb back through the same unsaved-version guard
  // the in-page back affordance used; clear on leave.
  useExternalSyncEffect(() => {
    setNavOpen({ id: clauseId, name: detail.title, exit: handleBack });
    return () => clearNav();
  }, [clauseId, detail.title, handleBack, setNavOpen, clearNav]);

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
      notifyUserError(toAPIError(response.error), t("clauses.saveFailed"), {
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    // Reflect the rename in the breadcrumb instantly, ahead of the refetch.
    setNavName(clauseId, trimmed);
    onRefresh();
  }, [clauseId, detail.title, titleDraft, t, onRefresh, setNavName]);

  const saveCategory = useCallback(
    async (value: string) => {
      const response = await api.clauses({ clauseId }).post({
        categoryId: value === "" ? null : toSafeId<"clauseCategory">(value),
      });

      if (response.error) {
        notifyUserError(toAPIError(response.error), t("clauses.saveFailed"), {
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
      return unwrapEden(response);
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
      notifyUserError(error, t("clauses.deleteFailed"), {
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    },
  });

  return (
    <div className="flex items-center gap-2">
      {editingTitle && canEdit ? (
        <InlineEdit
          className="min-w-0 flex-1 text-lg font-semibold"
          onCancel={() => {
            setTitleDraft(detail.title);
            setEditingTitle(false);
          }}
          onChange={setTitleDraft}
          onCommit={() => {
            detached(saveTitle(), "clause-detail.save-title");
          }}
          value={titleDraft}
        />
      ) : (
        <button
          className="flex-1 overflow-hidden text-start text-lg font-semibold text-ellipsis whitespace-pre disabled:cursor-default"
          dir="auto"
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
            detached(saveCategory(val ?? ""), "clause-detail.save-category");
          }}
          value={detail.categoryId ?? ""}
        >
          <SelectTrigger className="h-8 w-40 text-sm">
            <SelectValue placeholder={t("common.uncategorized")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("common.uncategorized")}</SelectItem>
            {categories.map((cat) => (
              <SelectItem dir="auto" key={cat.id} value={cat.id}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}

      {canEdit && (
        <Button
          disabled={
            !dirtySinceVersion || savingVersion || reviewStatus !== "resolved"
          }
          onClick={() => {
            detached(saveVersion(), "clause-detail.save-version");
          }}
          size="sm"
          variant="outline"
        >
          {t("clauses.saveAsVersion")}
        </Button>
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

      <ClauseLeaveDialog
        leaveDialog={leaveDialog}
        savingVersion={savingVersion}
        reviewStatus={reviewStatus}
        onClose={() => setLeaveDialog("closed")}
        onBack={onBack}
        leaveWithoutVersion={leaveWithoutVersion}
        saveVersionAndLeave={saveVersionAndLeave}
      />
    </div>
  );
};

// \u2500\u2500 Inline editable body (WYSIWYG, autosave) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ClauseBodyEditor = ({
  detail,
  canEdit,
  bodySave,
  rewrite,
}: {
  detail: ClauseDetail;
  canEdit: boolean;
  bodySave: ReturnType<typeof useClauseBodySave>;
  rewrite?: ClauseRewrite | undefined;
}) => {
  if (!canEdit) {
    return (
      <div className="mt-4 rounded-lg border p-4">
        <ClauseBody paragraphs={bodySave.body} />
      </div>
    );
  }

  return (
    <div className="mt-4">
      <ClauseEditor
        content={bodySave.body}
        onBlur={() => {
          detached(bodySave.flush(), "clause-detail.save-body");
        }}
        onChange={bodySave.change}
        onReviewResolved={bodySave.resolveReview}
        onReviewStatusChange={bodySave.onReviewStatusChange}
        rewrite={rewrite}
        title={detail.title}
        usageNotes={detail.usageNotes ?? undefined}
      />
    </div>
  );
};

// ── Inline metadata fields (autosave) ────────────────

/** Short single-line metadata field (description).
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
}: {
  field: "description";
  value: string | null;
  label: string;
  placeholder: string;
  clauseId: string;
  canEdit: boolean;
  onRefresh: () => void;
}) => {
  const [draft, setDraft] = useState(value ?? "");

  const commit = useClauseFieldSave({
    value,
    persist: async (next) => {
      const { data, error } = await api
        .clauses({ clauseId })
        .post({ [field]: next });
      return { data, error };
    },
    onRefresh,
    onError: () => setDraft(value ?? ""),
  });

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
        id={`clause-${field}`}
        onBlur={() => {
          detached(commit(draft), "clause-detail.commit");
        }}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        value={draft}
      />
    </div>
  );
};

// ── Language field (searchable single-select over ISO 639-1) ─

type LanguagePick = {
  code: string;
  label: string;
};

/** Single nullable clause language, picked from the canonical
 *  {@link LANGUAGES} list via a searchable combobox and autosaved as the
 *  base ISO 639-1 code (region tags canonicalized through `toLanguageCode`).
 *  Clearing the selection saves `null`. Legacy free-text values outside the
 *  enum still render (via `displayLanguageName`) and stay selected until the
 *  user re-picks. */
const ClauseLanguageField = ({
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
  const lang = useI18nStore((s) => s.lang);

  const compareLabel = compareByLocale(lang);
  const options: LanguagePick[] = LANGUAGES.map((language) => ({
    code: language.code,
    label: displayLanguageName(language.code, { displayLocale: lang }),
  })).toSorted((a, b) => compareLabel(a.label, b.label));

  // Keep a legacy/out-of-enum stored value selectable rather than dropping it.
  const selected: LanguagePick | null =
    value === null
      ? null
      : (options.find((option) => option.code === toLanguageCode(value)) ?? {
          code: value,
          label: displayLanguageName(value, { displayLocale: lang }),
        });

  const save = useCallback(
    async (next: string | null) => {
      const response = await api.clauses({ clauseId }).post({ language: next });

      if (response.error) {
        notifyUserError(toAPIError(response.error), t("clauses.saveFailed"), {
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

  const handleChange = (pick: LanguagePick | null) => {
    const next = pick === null ? null : (toLanguageCode(pick.code) ?? null);
    if (next === value) {
      return;
    }
    detached(save(next), "clause-detail.save");
  };

  if (!canEdit) {
    if (selected === null) {
      return null;
    }
    return (
      <div className="grid gap-1">
        <span className="text-muted-foreground text-xs font-medium">
          {t("common.language")}
        </span>
        <p className="text-muted-foreground text-sm">{selected.label}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium" htmlFor="clause-language">
        {t("common.language")}
      </label>
      <Combobox<LanguagePick>
        autoHighlight
        isItemEqualToValue={(a, b) => a.code === b.code}
        items={options}
        itemToStringLabel={(item) => item.label}
        onValueChange={handleChange}
        value={selected}
      >
        <ComboboxInput
          className="w-60"
          id="clause-language"
          placeholder={t("clauses.languagePlaceholder")}
          showClear
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

  const save = useClauseFieldSave({
    value,
    persist: async (next) => {
      const { data, error } = await api
        .clauses({ clauseId })
        .post({ usageNotes: next });
      return { data, error };
    },
    onRefresh,
  });

  const debouncedSave = useDebouncedCallback((text: string) => {
    detached(save(text), "clause-detail.save");
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
          detached(save(draft), "clause-detail.save");
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
  onPromote,
}: {
  clauseId: string;
  variants: VariantItem[];
  onRefresh: () => void;
  onPromote: (body: ClauseParagraph[]) => Promise<boolean>;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="mt-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-muted-foreground text-sm">
          {format.number(variants.length)}
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
              onPromote={onPromote}
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
  onPromote,
}: {
  variant: VariantItem;
  variants: VariantItem[];
  index: number;
  clauseId: string;
  onChanged: () => void;
  onPromote: (body: ClauseParagraph[]) => Promise<boolean>;
}) => {
  const t = useTranslations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [reordering, setReordering] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    const response = await api
      .clauses({ clauseId })
      .variants({ variantId: variant.id })
      .delete();

    setDeleting(false);

    if (response.error) {
      notifyUserError(toAPIError(response.error), t("clauses.deleteFailed"), {
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
  };

  const handlePromote = useCallback(async () => {
    const body = isClauseParagraphs(variant.body) ? variant.body : [];
    if (body.length === 0) {
      return;
    }

    setPromoting(true);
    const promoted = await onPromote(body);
    setPromoting(false);
    if (!promoted) {
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("clauses.variantPromoted"),
    });
    setPromoteOpen(false);
    onChanged();
  }, [variant.body, t, onChanged, onPromote]);

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
        notifyUserError(toAPIError(failure), t("clauses.saveFailed"), {
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
              detached(handleReorder("up"), "clause-detail.reorder");
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
              detached(handleReorder("down"), "clause-detail.reorder");
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
                detached(handleDelete(), "clause-detail.delete");
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
                detached(handlePromote(), "clause-detail.promote");
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

  const handleSave = async () => {
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
      notifyUserError(toAPIError(response.error), t("clauses.saveFailed"), {
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
  };

  return (
    <DialogPopup className="sm:max-w-md">
      <DialogFormState
        dirty={
          label !== (variant?.label ?? "") ||
          bodyText !== (variant ? variantBodyToText(variant.body) : "")
        }
        onDiscard={() => {
          setLabel(variant?.label ?? "");
          setBodyText(variant ? variantBodyToText(variant.body) : "");
        }}
      />
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
            detached(handleSave(), "clause-detail.save");
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
  onRestore,
}: {
  clauseId: string;
  currentBody: ClauseParagraph[];
  versions: VersionItem[];
  onRestore: (versionId: string) => Promise<boolean>;
}) => {
  const t = useTranslations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<ParagraphDiff[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped on every click so a slow response for an earlier version cannot
  // clobber the diff of a version selected later (or after a toggle-off).
  const requestGenerationRef = useRef(0);

  const handleVersionClick = async (versionId: string) => {
    if (selectedId === versionId) {
      requestGenerationRef.current += 1;
      setSelectedId(null);
      setDiffResult(null);
      setLoading(false);
      return;
    }

    requestGenerationRef.current += 1;
    const generation = requestGenerationRef.current;
    setSelectedId(versionId);
    setLoading(true);
    setDiffResult(null);

    const { data, error } = await api
      .clauses({ clauseId })
      .versions({ versionId })
      .get();

    if (generation !== requestGenerationRef.current) {
      // A newer click superseded this request; the winning request owns the
      // loading flag and diff state, so drop this stale response entirely.
      return;
    }

    setLoading(false);

    if (error) {
      notifyUserError(error, t("clauses.loadFailed"), {
        description: userErrorMessage(error, t("common.unexpectedError")),
      });
      setSelectedId(null);
      return;
    }

    if (data instanceof Response) {
      setSelectedId(null);
      return;
    }

    const oldBody = isClauseParagraphs(data.body) ? data.body : [];
    const diff = diffClauseBodies(oldBody, currentBody);
    setDiffResult(diff);
  };

  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground mt-4 py-4 text-center text-sm">
        {t("common.noVersions")}
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
              isSelected={selectedId === ver.id}
              key={ver.id}
              onRestore={onRestore}
              onToggleDiff={() => {
                detached(
                  handleVersionClick(ver.id),
                  "clause-detail.version-click",
                );
              }}
              version={ver}
            />
          ))}
        </ul>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Loader className="size-4" label={t("common.loading")} size="sm" />
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
  isSelected,
  onToggleDiff,
  onRestore,
}: {
  version: VersionItem;
  isSelected: boolean;
  onToggleDiff: () => void;
  onRestore: (versionId: string) => Promise<boolean>;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    const restored = await onRestore(version.id);
    setRestoring(false);
    if (!restored) {
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("clauses.versionRestored"),
    });
    setRestoreOpen(false);
  }, [version.id, t, onRestore]);

  return (
    <li className="flex items-center gap-2 px-2">
      <button
        className={cn(
          "flex flex-1 items-center justify-between",
          "px-2 py-3 text-sm",
          "hover:bg-muted/50 rounded",
          isSelected && "bg-muted",
        )}
        onClick={onToggleDiff}
        type="button"
      >
        <span className="font-medium">
          {t("common.versionLabel", {
            version: String(version.version),
          })}
        </span>
        <span className="text-muted-foreground">
          {format.dateTime(
            new Date(version.createdAt),
            MEDIUM_DATE_SHORT_TIME_FORMAT,
          )}
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
                detached(handleRestore(), "clause-detail.restore");
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
