import { useCallback, useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  HistoryIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  API_VERSION_CONFLICT_ERROR_CODE,
  normalizeApiError,
} from "@stll/api-contract";
import type { ApiErrorInput } from "@stll/api-contract";
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
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { useReferencePassageTexts } from "@/components/ai-suggestions/document-review-passage-texts";
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import {
  duplicatePosition,
  extractToGraded,
  gradedToExtract,
  hasErrors,
  moveAdjacent,
  newExtractPosition,
  newGradedPosition,
  type PlaybookApprovalStatus,
  type PlaybookPerspective,
  type PlaybookTrigger,
  type Position,
  type PositionErrors,
  type PositionSeverity,
  positionReferencePassages,
  positionTiers,
  validatePosition,
} from "@/lib/knowledge/playbook-types";
import type { PositionDecisionSummary } from "@/lib/knowledge/position-decisions";
import { readPositionDecisions } from "@/lib/knowledge/position-decisions";
import {
  documentTypesOptions,
  knowledgeKeys,
  playbookDetailOptions,
} from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { LeaveConfirmDialog } from "@/routes/_protected.knowledge/-components/leave-confirm-dialog";
import type { PlaybookDraft } from "@/routes/_protected.knowledge/-components/playbook-editor.logic";
import {
  buildPlaybookSavePayload,
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
  resolvePlaybookScrollTop,
} from "@/routes/_protected.knowledge/-components/playbook-editor.logic";
import { PlaybookVersionHistorySheet } from "@/routes/_protected.knowledge/-components/playbook-version-history-sheet";
import { PositionEditor } from "@/routes/_protected.knowledge/-components/position-editor";
import { usePlaybookNavStore } from "@/stores/knowledge/playbook-nav-store";

const PLAYBOOK_JUMP_TOP_OFFSET_PX = 24;
// Longer than a default error toast: the conflict toast carries the reload
// affordance, so it has to outlive a glance.
const VERSION_CONFLICT_TOAST_TIMEOUT_MS = 10_000;

// A 409 the optimistic-concurrency guard raised, off either channel the
// editor uses: Eden's error field on a direct call, or the `APIError`
// `unwrapEden` throws inside a mutation.
const isEdenVersionConflict = (error: ApiErrorInput): boolean =>
  normalizeApiError(error).code === API_VERSION_CONFLICT_ERROR_CODE;

const isThrownVersionConflict = (error: unknown): boolean =>
  APIError.is(error) && error.code === API_VERSION_CONFLICT_ERROR_CODE;

/** Title plus localized detail, shared by the toast and conflict paths. */
type ToastFailure = { title: string; description: string };

// ── Root component ────────────────────────────────────

type PlaybookEditorProps = {
  organizationId: string;
  playbookId: string | null;
  onBack: () => void;
  onSaved: () => void;
};

export const PlaybookEditor = ({
  organizationId,
  playbookId,
  onBack,
  onSaved,
}: PlaybookEditorProps) => {
  if (playbookId === null) {
    return (
      <PlaybookEditorForm
        initialApprovedAt={null}
        initialDescription=""
        initialDocumentTypeKey={null}
        initialName=""
        initialPerspective={null}
        initialStatus="draft"
        initialTrigger={null}
        initialPositions={[]}
        onBack={onBack}
        onSaved={onSaved}
        organizationId={organizationId}
        playbookId={null}
        updatedAt={null}
      />
    );
  }

  return (
    <PlaybookEditorLoader
      onBack={onBack}
      onSaved={onSaved}
      organizationId={organizationId}
      playbookId={playbookId}
    />
  );
};

const PlaybookEditorLoader = ({
  organizationId,
  playbookId,
  onBack,
  onSaved,
}: {
  organizationId: string;
  playbookId: string;
  onBack: () => void;
  onSaved: () => void;
}) => {
  const t = useTranslations();
  // Bumped after a version restore so the form below remounts with the
  // freshly refetched (already-invalidated) detail instead of holding on to
  // its own stale name/description/positions state.
  const [reloadKey, setReloadKey] = useState(0);
  const detailQuery = useQuery(
    playbookDetailOptions(organizationId, playbookId),
  );

  if (detailQuery.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("knowledge.playbooks.loading")}
        </p>
      </div>
    );
  }

  const detail = detailQuery.data;
  if (detailQuery.isError || !detail || !("positions" in detail)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("knowledge.playbooks.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <PlaybookEditorForm
      initialApprovedAt={detail.approvedAt}
      initialDescription={detail.description ?? ""}
      initialDocumentTypeKey={detail.scope?.documentTypeKey ?? null}
      initialName={detail.name}
      initialPerspective={detail.scope?.perspective ?? null}
      initialStatus={detail.status}
      initialTrigger={detail.scope?.trigger ?? null}
      initialPositions={detail.positions.items}
      key={reloadKey}
      onBack={onBack}
      // Derived from the org's findings on every read, so it tracks the cache
      // rather than freezing at mount like the `initial*` seeds.
      positionDecisions={readPositionDecisions(detail.positionDecisions)}
      onReload={() => setReloadKey((current) => current + 1)}
      onSaved={onSaved}
      organizationId={organizationId}
      playbookId={playbookId}
      // Live, unlike the `initial*` seeds: this is the optimistic-concurrency
      // token, so it has to track the cache (a save, an approve, or a
      // post-conflict refetch all move it) rather than freeze at mount.
      updatedAt={detail.updatedAt}
    />
  );
};

// ── Editor form ───────────────────────────────────────

// Sentinel for the "every document type" (unscoped) choice; a Select value
// can't be null, so it stands in and maps back to null.
const SCOPE_ALL_VALUE = "__all__";

type PlaybookEditorFormProps = {
  organizationId: string;
  playbookId: string | null;
  initialName: string;
  initialDescription: string;
  initialDocumentTypeKey: string | null;
  initialPerspective: PlaybookPerspective | null;
  initialTrigger: PlaybookTrigger | null;
  initialPositions: Position[];
  initialStatus: PlaybookApprovalStatus;
  initialApprovedAt: string | null;
  /** What the org's reviewers did with each position, by `sourceId`; empty
   *  for a playbook that has never been run. */
  positionDecisions?: ReadonlyMap<string, PositionDecisionSummary> | undefined;
  /** Concurrency token; tracks the cached detail, null for a new playbook. */
  updatedAt: string | null;
  onBack: () => void;
  onSaved: () => void;
  // Only supplied when editing an existing playbook (see
  // `PlaybookEditorLoader`): forces a remount on the freshly refetched
  // definition, after a version restore or a rejected stale save.
  onReload?: () => void;
};

const PlaybookEditorForm = ({
  organizationId,
  playbookId,
  initialName,
  initialDescription,
  initialDocumentTypeKey,
  initialPerspective,
  initialTrigger,
  initialPositions,
  initialStatus,
  initialApprovedAt,
  positionDecisions,
  updatedAt,
  onBack,
  onSaved,
  onReload,
}: PlaybookEditorFormProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const isEdit = playbookId !== null;
  const canSave = usePermissions(
    isEdit ? { playbook: ["update"] } : { playbook: ["create"] },
  );
  const canDelete = usePermissions({ playbook: ["delete"] });
  const canApprove = usePermissions({ playbook: ["approve"] });
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigationLeaveRequestedRef = useRef(false);

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [status, setStatus] = useState<PlaybookApprovalStatus>(initialStatus);
  const [approvedAt, setApprovedAt] = useState<string | null>(
    initialApprovedAt,
  );
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [positions, setPositions] = useState<Position[]>(() =>
    playbookId === null && initialPositions.length === 0
      ? [newGradedPosition()]
      : initialPositions,
  );
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(
    () => new Set(positions.slice(0, 1).map((p) => p.sourceId)),
  );
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  // Non-null while confirming a graded → extract conversion that would drop
  // authored tiers.
  const [convertConfirmId, setConvertConfirmId] = useState<string | null>(null);
  // Which document type this playbook runs for (null = every document). A
  // files-table run gates the materialized columns on the Document Type
  // classifier, so this is what makes "a different playbook per type" work.
  const [documentTypeKey, setDocumentTypeKey] = useState<string | null>(
    initialDocumentTypeKey,
  );
  // The clean state every later draft is measured against. Seeded from the
  // state above rather than from the props, so a New Playbook form — whose
  // positions are seeded with one empty card the props never carried — starts
  // clean instead of permanently dirty. Reseeded after every successful save;
  // the fingerprint is computed once per baseline, not per render.
  const [baseline, setBaseline] = useState(() =>
    createPlaybookBaseline({
      name,
      description,
      documentTypeKey,
      perspective: initialPerspective,
      trigger: initialTrigger,
      positions,
    }),
  );
  const { data: documentTypesData } = useQuery(
    documentTypesOptions(organizationId),
  );
  const documentTypes = documentTypesData ? documentTypesData.items : [];

  const setNavOpen = usePlaybookNavStore((s) => s.setOpen);
  const clearNav = usePlaybookNavStore((s) => s.clear);

  const displayName = name.trim() || t("knowledge.playbooks.createPlaybook");

  const draft: PlaybookDraft = {
    name,
    description,
    documentTypeKey,
    perspective: initialPerspective,
    trigger: initialTrigger,
    positions,
  };
  const isDirty = hasPlaybookDraftChanges({ baseline, current: draft });

  const navigationBlocker = useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: isDirty,
    withResolver: true,
  });

  const requestBack = useCallback(() => {
    if (isDirty) {
      setLeaveConfirmOpen(true);
      return;
    }
    onBack();
  }, [isDirty, onBack]);

  // Publish the open playbook to the breadcrumb (Knowledge › Playbooks › Name)
  // and wire its list crumb back through the in-page back affordance.
  useExternalSyncEffect(() => {
    setNavOpen({
      id: playbookId ?? "new",
      name: displayName,
      exit: requestBack,
    });
    return () => clearNav();
  }, [playbookId, displayName, requestBack, setNavOpen, clearNav]);

  const errorsById = new Map(
    positions.map((position): [string, PositionErrors] => [
      position.sourceId,
      validatePosition(position),
    ]),
  );

  // One read for the whole card list: a reference position quotes passages by
  // id, and the words come from the matters those references live in.
  const passageTexts = useReferencePassageTexts(
    positionReferencePassages(positions),
  );

  const setOpen = (sourceId: string, open: boolean) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (open) {
        next.add(sourceId);
      } else {
        next.delete(sourceId);
      }
      return next;
    });
  };

  const updatePosition = (sourceId: string, next: Position) => {
    setPositions((prev) =>
      prev.map((p) => (p.sourceId === sourceId ? next : p)),
    );
  };

  const removePosition = (sourceId: string) => {
    setPositions((prev) => prev.filter((p) => p.sourceId !== sourceId));
  };

  const addPosition = (mode: "graded" | "extract") => {
    const position =
      mode === "graded" ? newGradedPosition() : newExtractPosition();
    setPositions((prev) => [...prev, position]);
    setOpen(position.sourceId, true);
  };

  const duplicateAt = (sourceId: string) => {
    const index = positions.findIndex((p) => p.sourceId === sourceId);
    const original = positions[index];
    if (!original) {
      return;
    }
    const copy = duplicatePosition(original);
    setPositions((prev) => {
      const at = prev.findIndex((p) => p.sourceId === sourceId);
      return at === -1 ? [...prev, copy] : prev.toSpliced(at + 1, 0, copy);
    });
    setOpen(copy.sourceId, true);
  };

  const convertMode = (sourceId: string) => {
    const position = positions.find((p) => p.sourceId === sourceId);
    if (!position) {
      return;
    }
    if (position.mode === "extract") {
      updatePosition(sourceId, extractToGraded(position));
      return;
    }
    const tiers = positionTiers(position);
    // A reference standard always carries content (its passages are the
    // standard), so converting it to an extract position always confirms.
    const hasStandardContent =
      tiers === null ||
      tiers.acceptable.rules.length > 0 ||
      tiers.fallback.entries.length > 0 ||
      tiers.notAcceptable.rules.length > 0 ||
      tiers.acceptable.ideal !== undefined;
    if (hasStandardContent) {
      setConvertConfirmId(sourceId);
      return;
    }
    updatePosition(sourceId, gradedToExtract(position));
  };

  const confirmConvertToExtract = () => {
    if (convertConfirmId === null) {
      return;
    }
    const position = positions.find((p) => p.sourceId === convertConfirmId);
    if (position?.mode === "graded") {
      updatePosition(convertConfirmId, gradedToExtract(position));
    }
    setConvertConfirmId(null);
  };

  const reorderPosition = (draggedSourceId: string, targetSourceId: string) => {
    setPositions((prev) => {
      const from = prev.findIndex((p) => p.sourceId === draggedSourceId);
      const to = prev.findIndex((p) => p.sourceId === targetSourceId);
      if (from === -1 || to === -1 || from === to) {
        return prev;
      }
      const dragged = prev[from];
      if (!dragged) {
        return prev;
      }
      return prev.toSpliced(from, 1).toSpliced(to, 0, dragged);
    });
  };

  const movePosition = (sourceId: string, direction: "up" | "down") => {
    setPositions((prev) => {
      const index = prev.findIndex((p) => p.sourceId === sourceId);
      return moveAdjacent(prev, index, direction) ?? prev;
    });
  };

  const jumpToPosition = (sourceId: string) => {
    setOpen(sourceId, true);
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(
      `#position-${sourceId}`,
    );
    if (!container || !target) {
      return;
    }
    container.scrollTo({
      behavior: "smooth",
      top: resolvePlaybookScrollTop({
        containerScrollTop: container.scrollTop,
        containerTop: container.getBoundingClientRect().top,
        targetTop: target.getBoundingClientRect().top,
        topOffset: PLAYBOOK_JUMP_TOP_OFFSET_PX,
      }),
    });
  };

  /**
   * Write a freshly-returned `updatedAt` straight into the cached detail, so
   * the concurrency token this form reads is current before the invalidation
   * round-trip lands. Without it a second save inside that window would be
   * rejected as stale against a value the client already knows is superseded.
   */
  const syncUpdatedAt = (id: string, next: string) => {
    queryClient.setQueryData(
      playbookDetailOptions(organizationId, id).queryKey,
      (previous) =>
        previous && "updatedAt" in previous
          ? { ...previous, updatedAt: next }
          : previous,
    );
  };

  /**
   * A 409 means someone else moved the definition. Refetch so the token
   * catches up — the user's next save is then a deliberate overwrite rather
   * than the same rejection again — and offer a reload that swaps in the
   * server's copy instead of leaving a toast the user can only re-trigger.
   */
  const reportVersionConflict = (failure: ToastFailure) => {
    if (playbookId !== null) {
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.playbooks.detail(organizationId, playbookId),
        }),
        "playbook-editor.invalidate",
      );
    }
    stellaToast.add({
      type: "error",
      ...failure,
      ...(onReload
        ? {
            action: {
              // Reloading swaps in the server's copy, so name it for what it
              // costs while the draft still holds unsaved edits.
              label: isDirty
                ? t("knowledge.playbooks.discardChanges")
                : t("common.reload"),
              onClick: onReload,
            },
          }
        : {}),
      timeout: VERSION_CONFLICT_TOAST_TIMEOUT_MS,
    });
  };

  const handleSave = async (): Promise<boolean> => {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setAttemptedSave(true);
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.nameRequired"),
      });
      return false;
    }

    // Reuse the render-time validation map instead of re-running validatePosition
    // per position twice more on the save path.
    const invalidIds: string[] = [];
    for (const [id, positionErrors] of errorsById) {
      if (hasErrors(positionErrors)) {
        invalidIds.push(id);
      }
    }
    if (invalidIds.length > 0) {
      setAttemptedSave(true);
      // Expand every position that still has an error so the inline messages
      // are visible, not hidden inside a collapsed card.
      setOpenIds((prev) => {
        const next = new Set(prev);
        for (const id of invalidIds) {
          next.add(id);
        }
        return next;
      });
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.fixErrorsBeforeSaving"),
      });
      return false;
    }

    // The one place the save body is built — the same builder the dirty check
    // fingerprints, so a field can never be saved without being tracked.
    const savedDraft = draft;
    const payload = buildPlaybookSavePayload(savedDraft);

    // Shared by both endpoints: a 409 takes the conflict path (refetch plus a
    // reload affordance), anything else is a plain error toast.
    const reportSaveFailure = (error: ApiErrorInput) => {
      const failure = {
        title: t("knowledge.playbooks.saveFailed"),
        description: userErrorMessage(error, t("common.unexpectedError")),
      };
      if (isEdenVersionConflict(error)) {
        reportVersionConflict(failure);
        return;
      }
      stellaToast.add({ type: "error", ...failure });
    };

    // Each branch awaits its own Eden call and inspects `.error` before
    // touching `.data`: Eden resolves rather than throwing, so a failed
    // request reads as success anywhere the response is not checked.
    setSaving(true);
    if (playbookId === null) {
      const response = await api.playbooks.post(payload);
      setSaving(false);
      if (response.error) {
        reportSaveFailure(response.error);
        return false;
      }
    } else {
      const response = await api
        .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
        // Sent whenever the editor has a token: a save that would clobber
        // someone else's is refused rather than silently winning.
        .put({
          ...payload,
          ...(updatedAt === null ? {} : { expectedUpdatedAt: updatedAt }),
        });
      setSaving(false);
      if (response.error) {
        reportSaveFailure(response.error);
        return false;
      }
      syncUpdatedAt(playbookId, response.data.updatedAt);
    }

    // What was just persisted is the new clean state; the draft may have moved
    // on during the request, and comparing against this snapshot keeps those
    // later keystrokes dirty.
    setBaseline(createPlaybookBaseline(savedDraft));

    stellaToast.add({
      type: "success",
      title: isEdit
        ? t("knowledge.playbooks.updated")
        : t("knowledge.playbooks.created"),
    });
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.playbooks.all(organizationId),
      }),
      "playbook-editor.invalidate",
    );
    return true;
  };

  /**
   * Runs the save and hands the outcome to `after`. The three "save now"
   * affordances (toolbar, in-page leave, and navigation block) each follow up
   * differently but must not each re-derive the await dance. Callers detach
   * the returned promise under their own label.
   */
  const saveThen = async (after: (saved: boolean) => void) => {
    after(await handleSave());
  };

  const handleDelete = async () => {
    if (playbookId === null) {
      return;
    }
    setSaving(true);
    const response = await api
      .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
      .delete();
    setSaving(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.deleteFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("knowledge.playbooks.deleted"),
    });
    setDeleteOpen(false);
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.playbooks.all(organizationId),
      }),
      "playbook-editor.invalidate",
    );
    onSaved();
  };

  const approveMutation = useMutation({
    mutationFn: async ({
      id,
      expectedUpdatedAt,
    }: {
      id: string;
      expectedUpdatedAt: string;
    }) => {
      const response = await api
        .playbooks({ playbookId: toSafeId<"playbookDefinition">(id) })
        .approve.post({ expectedUpdatedAt });
      return unwrapEden(response);
    },
    onSuccess: (data, { id }) => {
      setStatus("approved");
      setApprovedAt(data.approvedAt);
      // The approval's own `updatedAt`, not `approvedAt` standing in for it:
      // the two happen to coincide today, and a client that leans on that
      // breaks the moment the handler stops writing them together.
      syncUpdatedAt(id, data.updatedAt);
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.playbooks.all(organizationId),
        }),
        "playbook-editor.invalidate",
      );
      stellaToast.add({
        type: "success",
        title: t("knowledge.playbooks.approval.approvedToast"),
      });
    },
    onError: (error) => {
      const failure = {
        title: t("knowledge.playbooks.approval.approveFailed"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      };
      if (isThrownVersionConflict(error)) {
        reportVersionConflict(failure);
        return;
      }
      stellaToast.add({ type: "error", ...failure });
    },
  });

  const handleApprove = () => {
    // `isDirty` is also what disables the button; re-checked here because a
    // disabled button carrying a tooltip stays interactive to the browser.
    if (playbookId === null || updatedAt === null || isDirty) {
      return;
    }
    approveMutation.mutate({ id: playbookId, expectedUpdatedAt: updatedAt });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={scrollRef}
    >
      <div className="mx-auto flex w-full max-w-5xl gap-8 p-6">
        <div className="min-w-0 flex-1 space-y-6">
          <div className="flex items-center justify-between gap-2">
            <Button
              onClick={requestBack}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ArrowLeftIcon />
              {t("common.back")}
            </Button>
            <div className="flex items-center gap-2">
              {isEdit && (
                <PlaybookStatusBadge approvedAt={approvedAt} status={status} />
              )}
              {isDirty && (
                <span className="text-muted-foreground text-xs">
                  {t("knowledge.playbooks.unsavedChanges")}
                </span>
              )}
              {isEdit && (
                <Button
                  onClick={() => setVersionHistoryOpen(true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <HistoryIcon />
                  {t("knowledge.playbooks.versions.versionHistory")}
                </Button>
              )}
              {isEdit && canApprove && (
                <Button
                  disabled={isDirty || approveMutation.isPending}
                  loading={approveMutation.isPending}
                  onClick={handleApprove}
                  size="sm"
                  tooltip={
                    isDirty
                      ? t("knowledge.playbooks.approval.saveBeforeApprove")
                      : undefined
                  }
                  type="button"
                  variant="outline"
                >
                  <ShieldCheckIcon />
                  {t("knowledge.playbooks.approval.approve")}
                </Button>
              )}
              {isEdit && canDelete && (
                <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
                  <Button
                    aria-label={t("knowledge.playbooks.deletePlaybook")}
                    onClick={() => setDeleteOpen(true)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon />
                  </Button>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("knowledge.playbooks.deletePlaybook")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("knowledge.playbooks.confirmDelete")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="ghost" />}>
                        {t("common.cancel")}
                      </AlertDialogClose>
                      <Button
                        disabled={saving}
                        onClick={() => {
                          detached(handleDelete(), "playbook-editor.delete");
                        }}
                        variant="destructive"
                      >
                        {t("common.delete")}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              )}
              <Button
                disabled={!canSave || !isDirty || saving}
                loading={saving}
                onClick={() => {
                  detached(
                    saveThen((saved) => {
                      if (saved) {
                        onSaved();
                      }
                    }),
                    "playbook-editor.save",
                  );
                }}
                type="button"
              >
                {t("common.save")}
              </Button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="playbook-name">{t("common.name")}</Label>
            <Input
              aria-invalid={attemptedSave && name.trim() === ""}
              id="playbook-name"
              onChange={(e) => setName(e.target.value)}
              placeholder={t("knowledge.playbooks.namePlaceholder")}
              value={name}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="playbook-description">
              {t("common.description")}
            </Label>
            <Textarea
              className="min-h-[60px]"
              id="playbook-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("knowledge.playbooks.descriptionPlaceholder")}
              value={description}
            />
          </div>

          {documentTypes.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="playbook-document-type">{t("common.type")}</Label>
              <Select
                onValueChange={(next) =>
                  setDocumentTypeKey(
                    next === null || next === SCOPE_ALL_VALUE ? null : next,
                  )
                }
                value={documentTypeKey ?? SCOPE_ALL_VALUE}
              >
                <SelectTrigger id="playbook-document-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={SCOPE_ALL_VALUE}>
                    {t("common.all")}
                  </SelectItem>
                  {documentTypes.map((documentType) => (
                    <SelectItem key={documentType.key} value={documentType.key}>
                      {documentType.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Link
                className="text-muted-foreground hover:text-foreground text-xs"
                to="/settings/organization/document-types"
              >
                {t("knowledge.playbooks.manageTypes")}
              </Link>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                {t("knowledge.playbooks.positions")}
              </h2>
              <AddPositionMenu onAdd={addPosition} />
            </div>

            {positions.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                {t("knowledge.playbooks.noPositions")}
              </p>
            ) : (
              <ul className="space-y-3">
                {positions.map((position, index) => (
                  <PositionEditor
                    decision={positionDecisions?.get(position.sourceId)}
                    errors={errorsById.get(position.sourceId) ?? {}}
                    index={index}
                    key={position.sourceId}
                    onChange={(next) => updatePosition(position.sourceId, next)}
                    onConvertMode={() => convertMode(position.sourceId)}
                    onDuplicate={() => duplicateAt(position.sourceId)}
                    onMoveDown={() => movePosition(position.sourceId, "down")}
                    onMoveUp={() => movePosition(position.sourceId, "up")}
                    onOpenChange={(open) => setOpen(position.sourceId, open)}
                    onRemove={() => removePosition(position.sourceId)}
                    onReorder={reorderPosition}
                    open={openIds.has(position.sourceId)}
                    organizationId={organizationId}
                    passageTexts={passageTexts}
                    position={position}
                    showErrors={attemptedSave}
                    total={positions.length}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {positions.length > 0 && (
          <OutlineRail onJump={jumpToPosition} positions={positions} />
        )}
      </div>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setConvertConfirmId(null);
          }
        }}
        open={convertConfirmId !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("knowledge.playbooks.convertToExtractTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("knowledge.playbooks.convertToExtractDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={
                <Button
                  onClick={confirmConvertToExtract}
                  variant="destructive"
                />
              }
            >
              {t("knowledge.playbooks.convertToExtract")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {playbookId !== null && (
        <PlaybookVersionHistorySheet
          onOpenChange={setVersionHistoryOpen}
          onRestored={() => onReload?.()}
          open={versionHistoryOpen}
          organizationId={organizationId}
          playbookId={playbookId}
        />
      )}

      <LeaveConfirmDialog
        cancelLabel={t("common.goBackToEditing")}
        description={t("common.unsavedLeaveConfirm")}
        onOpenChange={setLeaveConfirmOpen}
        open={leaveConfirmOpen}
        primary={{
          label: t("common.saveAndLeave"),
          onClick: () => {
            detached(
              saveThen((saved) => {
                if (saved) {
                  onSaved();
                }
              }),
              "playbook-editor.save-and-leave",
            );
          },
        }}
        secondary={{
          label: t("knowledge.playbooks.discardChanges"),
          onClick: onBack,
          variant: "destructive",
        }}
      />

      <LeaveConfirmDialog
        cancelLabel={t("common.goBackToEditing")}
        description={t("common.unsavedLeaveConfirm")}
        onOpenChange={(open) => {
          if (open || navigationBlocker.status !== "blocked") {
            return;
          }
          // "Save and leave" closes the dialog before the save resolves; hold
          // the block until it does, instead of cancelling the navigation the
          // user asked to complete.
          if (navigationLeaveRequestedRef.current) {
            navigationLeaveRequestedRef.current = false;
            return;
          }
          navigationBlocker.reset();
        }}
        open={navigationBlocker.status === "blocked"}
        primary={{
          label: t("common.saveAndLeave"),
          onClick: () => {
            navigationLeaveRequestedRef.current = true;
            detached(
              saveThen((saved) => {
                if (navigationBlocker.status !== "blocked") {
                  return;
                }
                // A rejected save must not leave the dialog open over a latch
                // nothing will release. Cancel the navigation and close: the
                // draft is intact and `handleSave` has already said why.
                if (saved) {
                  navigationBlocker.proceed();
                } else {
                  navigationLeaveRequestedRef.current = false;
                  navigationBlocker.reset();
                }
              }),
              "playbook-editor.save-and-navigate",
            );
          },
        }}
        secondary={{
          label: t("knowledge.playbooks.discardChanges"),
          onClick: () => {
            if (navigationBlocker.status === "blocked") {
              navigationBlocker.proceed();
            }
          },
          variant: "destructive",
        }}
      />
    </div>
  );
};

// ── Status badge ──────────────────────────────────────

const PlaybookStatusBadge = ({
  status,
  approvedAt,
}: {
  status: PlaybookApprovalStatus;
  approvedAt: string | null;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  if (status === "approved") {
    return (
      <Tooltip
        content={
          approvedAt
            ? t("knowledge.playbooks.approval.approvedOn", {
                date: format.dateTime(new Date(approvedAt), {
                  dateStyle: "medium",
                }),
              })
            : undefined
        }
        render={
          <span className="bg-success/15 text-success inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase" />
        }
      >
        {t("knowledge.playbooks.approval.statusApproved")}
      </Tooltip>
    );
  }

  return (
    <span className="bg-muted text-muted-foreground inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
      {t("knowledge.playbooks.approval.statusDraft")}
    </span>
  );
};

// ── Add-position menu (graded vs extract) ─────────────

const AddPositionMenu = ({
  onAdd,
}: {
  onAdd: (mode: "graded" | "extract") => void;
}) => {
  const t = useTranslations();
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" type="button" variant="outline" />}
      >
        <PlusIcon />
        {t("knowledge.playbooks.addPosition")}
        <ChevronDownIcon className="opacity-70" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => onAdd("graded")}>
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {t("knowledge.playbooks.addGradedPosition")}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("knowledge.playbooks.addGradedPositionHint")}
            </span>
          </div>
        </MenuItem>
        <MenuItem onClick={() => onAdd("extract")}>
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {t("knowledge.playbooks.addExtractPosition")}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("knowledge.playbooks.addExtractPositionHint")}
            </span>
          </div>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
};

// ── Sticky outline rail ───────────────────────────────

const SEVERITY_DOT_VAR = {
  blocker: "--color-destructive",
  high: "--color-warning",
  medium: "--color-primary",
  low: "--color-muted-foreground",
} as const satisfies Record<PositionSeverity, string>;

const OutlineRail = ({
  positions,
  onJump,
}: {
  positions: Position[];
  onJump: (sourceId: string) => void;
}) => {
  const t = useTranslations();
  return (
    <nav
      aria-label={t("knowledge.playbooks.outline")}
      className="sticky top-6 hidden h-fit w-48 shrink-0 lg:block"
    >
      <p className="text-foreground-label mb-2 px-2 text-xs font-semibold">
        {t("knowledge.playbooks.outline")}
      </p>
      <ol className="space-y-0.5">
        {positions.map((position, index) => {
          const issue = position.issue.trim();
          return (
            <li key={position.sourceId}>
              <Button
                className={cn(
                  "hover:bg-muted h-8 w-full items-center justify-start rounded-md px-2 text-start font-normal focus-visible:ring-offset-0 focus-visible:ring-inset sm:h-8",
                  !position.enabled && "opacity-50",
                )}
                onClick={() => onJump(position.sourceId)}
                size="xs"
                variant="ghost"
              >
                <span className="text-foreground-ghost w-5 shrink-0 text-[10px] font-semibold tracking-[0.04em] tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm leading-5",
                    issue
                      ? "text-foreground font-medium"
                      : "text-muted-foreground italic",
                  )}
                  dir="auto"
                >
                  {issue || t("knowledge.playbooks.untitledPosition")}
                </span>
                {position.mode === "graded" && (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: `var(${SEVERITY_DOT_VAR[position.severity]})`,
                    }}
                  />
                )}
              </Button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
