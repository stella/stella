import { useCallback, useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
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
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  HistoryIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { ReviewOutOfDateNotice } from "@stll/ui/review-out-of-date-notice";
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
import {
  guideAnchor,
  guideReverseBlocked,
} from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { LeaveConfirmDialog } from "@/features/knowledge/leave-confirm-dialog";
import type {
  FresherDetail,
  PlaybookDraft,
  PlaybookSnapshot,
  PositionSourceLookup,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import {
  buildPlaybookSavePayload,
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
  hasResolvedPositionSources,
  detailSeedGate,
  latchedSeedGate,
  refetchSupersededDetail,
  resolveDetailSeed,
  resolvePlaybookScrollTop,
  resolvePositionSources,
  resolveServerFollow,
  toPositionSourceLookup,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import { PlaybookVersionHistorySheet } from "@/features/knowledge/playbook-editor/playbook-version-history-sheet";
import { PositionEditor } from "@/features/knowledge/playbook-editor/position-editor";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError, APIError, unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  duplicatePosition,
  extractToGraded,
  gradedToExtract,
  hasErrors,
  moveAdjacent,
  newExtractPosition,
  newGradedPosition,
  type PlaybookApprovalStatus,
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
import { useQueryView } from "@/lib/use-query-view";
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

const NEW_PLAYBOOK_SNAPSHOT: PlaybookSnapshot = {
  draft: {
    name: "",
    description: "",
    documentTypeKey: null,
    perspective: null,
    trigger: null,
    positions: [],
  },
  updatedAt: null,
  status: "draft",
  approvedAt: null,
};

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
        onBack={onBack}
        onSaved={onSaved}
        organizationId={organizationId}
        playbookId={null}
        server={NEW_PLAYBOOK_SNAPSHOT}
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
  const queryClient = useQueryClient();
  const detailOptions = playbookDetailOptions(organizationId, playbookId);
  // The gate is computed just before the form takes its initial values: at
  // mount, and on each reload (after a version restore or a rejected stale
  // save). For example, reopening the editor right after a save finds the
  // cached detail invalidated but still holding the pre-save content until
  // the refetch completes. Changing `reloadKey` remounts the form so it
  // picks up the new values.
  const [seedState, setSeedState] = useState(() => ({
    reloadKey: 0,
    gate: detailSeedGate(queryClient.getQueryState(detailOptions.queryKey)),
  }));
  const detailQuery = useQuery(detailOptions);
  const detailView = useQueryView(detailQuery, {
    isEmpty: (detail) => !("positions" in detail),
  });
  const seed = resolveDetailSeed({
    gate: seedState.gate,
    dataUpdatedAt: detailQuery.dataUpdatedAt,
    fetchStatus: detailQuery.fetchStatus,
  });
  // The form has now been filled from the outdated copy. Record that, so a
  // later refetch cannot unmount the form and lose what the user typed.
  const latchedGate = latchedSeedGate(seedState.gate, seed);
  if (latchedGate !== null) {
    setSeedState({ reloadKey: seedState.reloadKey, gate: latchedGate });
  }

  const refetchDetail = () => {
    // If a refetch is already running, wait for it instead of restarting it.
    detached(
      detailQuery.refetch({ cancelRefetch: false }),
      "playbook-editor.refetch-detail",
    );
  };

  const reload = () => {
    const gate = detailSeedGate(
      queryClient.getQueryState(detailOptions.queryKey),
    );
    if (gate.type === "awaiting") {
      refetchDetail();
    }
    setSeedState((current) => ({ reloadKey: current.reloadKey + 1, gate }));
  };

  const readFailure = (
    <div className="flex items-center justify-center gap-2 p-4" role="alert">
      <p className="text-destructive text-sm">
        {t("common.somethingWentWrong")}
      </p>
      <Button onClick={refetchDetail} size="sm" variant="ghost">
        {t("common.retry")}
      </Button>
    </div>
  );

  switch (detailView.type) {
    case "pending":
      return (
        <div
          className="flex flex-1 items-center justify-center p-8"
          role="status"
        >
          <p className="text-muted-foreground text-sm">
            {t("knowledge.playbooks.loading")}
          </p>
        </div>
      );
    case "error":
      return readFailure;
    case "empty":
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <Button onClick={onBack} variant="ghost">
            {t("common.goBack")}
          </Button>
        </div>
      );
    case "items":
      break;
    default:
      detailView satisfies never;
      return panic("Unhandled playbook detail query state");
  }

  if (seed.type === "wait") {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("knowledge.playbooks.loading")}
        </p>
      </div>
    );
  }

  const detail = detailView.items;
  if (!("positions" in detail)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        {readFailure}
      </div>
    );
  }

  return (
    <>
      {detailView.refetchError !== undefined && readFailure}
      <PlaybookEditorForm
        key={seedState.reloadKey}
        onBack={onBack}
        // Derived from the org's findings on every read, so it tracks the cache.
        positionDecisions={readPositionDecisions(detail.positionDecisions)}
        // Looked up for this reader on every read, like the decisions above.
        positionSources={toPositionSourceLookup(detail.positionSources)}
        onReload={reload}
        onSaved={onSaved}
        organizationId={organizationId}
        playbookId={playbookId}
        server={{
          draft: {
            name: detail.name,
            description: detail.description ?? "",
            documentTypeKey: detail.scope?.documentTypeKey ?? null,
            perspective: detail.scope?.perspective ?? null,
            trigger: detail.scope?.trigger ?? null,
            positions: detail.positions.items,
          },
          updatedAt: detail.updatedAt,
          status: detail.status,
          approvedAt: detail.approvedAt,
        }}
        staleDetail={
          seed.type === "stale"
            ? { fresher: seed.fresher, onRetry: refetchDetail }
            : undefined
        }
      />
    </>
  );
};

// ── Stale detail notice ───────────────────────────────

type StaleDetail = {
  fresher: FresherDetail;
  onRetry: () => void;
};

/**
 * Shown above a form that was filled from an outdated detail. Retry only
 * refetches; it does not touch the form. Once a fresh copy has loaded, the
 * user chooses when to reload the form with it, so a retry that fails again
 * loses none of their edits.
 */
const StaleDetailNotice = ({
  staleDetail: { fresher, onRetry },
  isDirty,
  onReload,
}: {
  staleDetail: StaleDetail;
  isDirty: boolean;
  onReload: (() => void) | undefined;
}) => {
  const t = useTranslations();
  switch (fresher) {
    case "unavailable": {
      return (
        <ReviewOutOfDateNotice
          actionLabel={t("common.retry")}
          onAction={onRetry}
          reasons={[
            {
              id: "stale-detail",
              label: t("knowledge.playbooks.staleCopy.unavailable"),
            },
          ]}
        />
      );
    }
    case "loading": {
      return (
        <ReviewOutOfDateNotice
          reasons={[
            {
              id: "stale-detail",
              label: t("knowledge.playbooks.staleCopy.unavailable"),
            },
          ]}
        />
      );
    }
    case "loaded": {
      return (
        <ReviewOutOfDateNotice
          // Reloading replaces the form with the server's copy. If there are
          // unsaved edits, label the button "discard changes" to say so.
          actionLabel={
            isDirty
              ? t("knowledge.playbooks.discardChanges")
              : t("common.reload")
          }
          onAction={onReload}
          reasons={[
            {
              id: "stale-detail",
              label: t("knowledge.playbooks.staleCopy.loaded"),
            },
          ]}
        />
      );
    }
    default: {
      fresher satisfies never;
      return panic(`Unhandled stale detail state: ${String(fresher)}`);
    }
  }
};

// ── Editor form ───────────────────────────────────────

// Sentinel for the "every document type" (unscoped) choice; a Select value
// can't be null, so it stands in and maps back to null.
const SCOPE_ALL_VALUE = "__all__";

type PlaybookEditorFormProps = {
  organizationId: string;
  playbookId: string | null;
  /** The playbook as the server last returned it, passed on every render:
   *  the form seeds from it at mount and follows it while it has no edits. */
  server: PlaybookSnapshot;
  /** What the org's reviewers did with each position, by `sourceId`; empty
   *  for a playbook that has never been run. */
  positionDecisions?: ReadonlyMap<string, PositionDecisionSummary> | undefined;
  /** The source documents this reader can open; absent for a new playbook,
   *  which has none. */
  positionSources?: PositionSourceLookup | undefined;
  /** Set when the form was filled from an outdated detail because the
   *  refetch did not complete (offline, or the request failed). */
  staleDetail?: StaleDetail | undefined;
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
  server,
  positionDecisions,
  positionSources,
  staleDetail,
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

  // The token stays with the draft it was read with. It moves on this form's
  // own writes, or together with the content when the form follows a newer
  // server version (see `resolveServerFollow`). Were it to move alone, a
  // refetch under the form (a chat save, another editor, a window refocus)
  // would pair a fresh token with a stale draft, and the next save, a full
  // replace, would silently drop the change that moved it instead of meeting
  // the version conflict.
  const [updatedAt, setUpdatedAt] = useState(server.updatedAt);
  const [name, setName] = useState(server.draft.name);
  const [description, setDescription] = useState(server.draft.description);
  const [perspective, setPerspective] = useState(server.draft.perspective);
  const [trigger, setTrigger] = useState(server.draft.trigger);
  const [status, setStatus] = useState(server.status);
  const [approvedAt, setApprovedAt] = useState(server.approvedAt);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [positions, setPositions] = useState<Position[]>(() =>
    playbookId === null && server.draft.positions.length === 0
      ? [newGradedPosition()]
      : [...server.draft.positions],
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
  const [documentTypeKey, setDocumentTypeKey] = useState(
    server.draft.documentTypeKey,
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
      perspective,
      trigger,
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
    perspective,
    trigger,
    positions,
  };
  const isDirty = hasPlaybookDraftChanges({ baseline, current: draft });

  // Another writer (a chat, an agent, a second editor) saved a newer version.
  // A form without edits takes it in place: cards are keyed by `sourceId`,
  // which saves keep stable, so expanded cards and scroll position hold.
  // Adjusting state during render settles in the same pass, before paint.
  const serverFollow = resolveServerFollow({
    formUpdatedAt: updatedAt,
    serverUpdatedAt: server.updatedAt,
    isDirty,
  });
  if (serverFollow.type === "reseed") {
    const nextPositions = [...server.draft.positions];
    setName(server.draft.name);
    setDescription(server.draft.description);
    setDocumentTypeKey(server.draft.documentTypeKey);
    setPerspective(server.draft.perspective);
    setTrigger(server.draft.trigger);
    setPositions(nextPositions);
    setBaseline(
      createPlaybookBaseline({ ...server.draft, positions: nextPositions }),
    );
    setStatus(server.status);
    setApprovedAt(server.approvedAt);
    setUpdatedAt(server.updatedAt);
  }

  const navigationBlocker = useUnsavedWork({
    surface: "playbook-editor",
    guard: "confirm-navigation",
    isDirty,
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

  const takeFreshToken = async (id: string) => {
    const fresh = await refetchSupersededDetail(
      queryClient,
      playbookDetailOptions(organizationId, id).queryKey,
    );
    if (fresh !== null && "updatedAt" in fresh) {
      setUpdatedAt(fresh.updatedAt);
    }
  };

  /**
   * A 409 means someone else moved the definition. Refetch and take the fresh
   * token (the one place it moves without a write of this form's own): the
   * user has now been told, so their next save is a deliberate overwrite
   * rather than the same rejection again. Also offer a reload that swaps in
   * the server's copy instead of leaving a toast the user can only re-trigger.
   */
  const reportVersionConflict = (failure: ToastFailure) => {
    if (playbookId !== null) {
      detached(
        takeFreshToken(playbookId),
        "playbook-editor.refetch-after-conflict",
      );
    }
    notifyUserError(undefined, failure.title, {
      description: failure.description,
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
      notifyUserError(undefined, t("knowledge.playbooks.nameRequired"));
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
      notifyUserError(
        undefined,
        t("knowledge.playbooks.fixErrorsBeforeSaving"),
      );
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
      notifyUserError(toAPIError(error), failure.title, {
        description: failure.description,
      });
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
      setUpdatedAt(response.data.updatedAt);
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
      notifyUserError(
        toAPIError(response.error),
        t("knowledge.playbooks.deleteFailed"),
        {
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        },
      );
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
    onSuccess: (data) => {
      setStatus("approved");
      setApprovedAt(data.approvedAt);
      // The approval's own `updatedAt`, not `approvedAt` standing in for it:
      // the two happen to coincide today, and a client that leans on that
      // breaks the moment the handler stops writing them together.
      setUpdatedAt(data.updatedAt);
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
      notifyUserError(error, failure.title, {
        description: failure.description,
      });
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
      className="@container flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={scrollRef}
    >
      <div className="mx-auto flex w-full max-w-5xl gap-8 p-4 @lg:p-6">
        <div className="min-w-0 flex-1 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              onClick={requestBack}
              size="sm"
              type="button"
              variant="ghost"
              {...guideAnchor(GUIDE_ANCHORS.playbooksBack)}
              {...guideReverseBlocked(isDirty)}
            >
              <ArrowLeftIcon />
              {t("common.back")}
            </Button>
            <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
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

          {/* Once the fresher copy has loaded, a form without edits has already
              followed it; the notice stays only over unsaved edits. */}
          {staleDetail !== undefined &&
            (staleDetail.fresher !== "loaded" ||
              serverFollow.type === "behind") && (
              <StaleDetailNotice
                isDirty={isDirty}
                onReload={onReload}
                staleDetail={staleDetail}
              />
            )}

          {isEdit &&
            canApprove &&
            status === "draft" &&
            positionSources !== undefined &&
            hasResolvedPositionSources(positions, positionSources) && (
              <p className="text-muted-foreground text-end text-xs text-pretty">
                {t("knowledge.playbooks.approval.sourcesNotice")}
              </p>
            )}

          <div
            className="space-y-6"
            {...guideAnchor(GUIDE_ANCHORS.playbooksBasics)}
          >
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
                <Label htmlFor="playbook-document-type">
                  {t("common.type")}
                </Label>
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
                      <SelectItem
                        key={documentType.key}
                        value={documentType.key}
                      >
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
          </div>

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
                    sources={
                      positionSources === undefined
                        ? []
                        : resolvePositionSources(position, positionSources)
                    }
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
          <span className="bg-success/15 text-success text-3xs inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tracking-wider uppercase" />
        }
      >
        {t("knowledge.playbooks.approval.statusApproved")}
      </Tooltip>
    );
  }

  return (
    <span className="bg-muted text-muted-foreground text-3xs inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tracking-wider uppercase">
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
        render={
          <Button
            size="sm"
            type="button"
            variant="outline"
            {...guideAnchor(GUIDE_ANCHORS.playbooksAddPosition)}
          />
        }
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
      className="sticky top-6 hidden h-fit w-48 shrink-0 @3xl:block"
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
                <span className="text-foreground-ghost text-3xs w-5 shrink-0 font-semibold tracking-[0.04em] tabular-nums">
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
