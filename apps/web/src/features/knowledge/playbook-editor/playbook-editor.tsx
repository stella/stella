import { useCallback, useId, useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useDebouncedCallback } from "use-debounce";
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
import { ChevronDownIcon, PlusIcon } from "@stll/ui/icons";
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
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { LeaveConfirmDialog } from "@/features/knowledge/leave-confirm-dialog";
import type { PlaybookSnapshot } from "@/features/knowledge/playbook-editor/playbook-editor-sync.logic";
import {
  canAutosave,
  draftToAdopt,
  resolvePaneSaveStatus,
  resolveServerFollow,
  resolveSavedPlaybookState,
} from "@/features/knowledge/playbook-editor/playbook-editor-sync.logic";
import { PlaybookEditorToolbar } from "@/features/knowledge/playbook-editor/playbook-editor-toolbar";
import type { TourAttributes } from "@/features/knowledge/playbook-editor/playbook-editor-toolbar";
import type {
  FresherDetail,
  PlaybookDraft,
  PositionSourceLookup,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import {
  buildPlaybookSavePayload,
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
  hasResolvedPositionSources,
  detailSeedGate,
  invalidPositionIds,
  latchedSeedGate,
  refetchSupersededDetail,
  resolveDetailSeed,
  resolvePlaybookScrollTop,
  resolvePositionSources,
  toPositionSourceLookup,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import {
  discardParkedPlaybookPane,
  parkPlaybookPane,
  readParkedPlaybookPane,
  registerPlaybookPaneLeaveGuard,
} from "@/features/knowledge/playbook-editor/playbook-pane-parking";
import type { ParkedPlaybookPane } from "@/features/knowledge/playbook-editor/playbook-pane-parking";
import { PlaybookVersionHistorySheet } from "@/features/knowledge/playbook-editor/playbook-version-history-sheet";
import { PositionEditor } from "@/features/knowledge/playbook-editor/position-editor";
import {
  usePlaybookSaveQueue,
  usePlaybookDetailSaveSubscription,
} from "@/features/knowledge/playbook-editor/use-playbook-save-queue";
import type {
  SaveOutcome,
  SendSaveArgs,
} from "@/features/knowledge/playbook-editor/use-playbook-save-queue";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError, APIError, unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  duplicatePosition,
  extractToGraded,
  gradedToExtract,
  moveAdjacent,
  newExtractPosition,
  newGradedPosition,
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
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { usePlaybookNavStore } from "@/stores/knowledge/playbook-nav-store";

const PLAYBOOK_JUMP_TOP_OFFSET_PX = 24;
// Saves from a chat in this browser invalidate the detail at once; this
// brings in the rest (the CLI, MCP, another browser) while an editor is open.
const OPEN_EDITOR_REFETCH_INTERVAL_MS = 30_000;
// Longer than a default error toast: the conflict toast carries the reload
// affordance, so it has to outlive a glance.
const VERSION_CONFLICT_TOAST_TIMEOUT_MS = 10_000;
// A draft save keeps no version, so once this toast goes, a removed
// position is gone for good.
const POSITION_REMOVED_TOAST_TIMEOUT_MS = 10_000;

// A 409 the optimistic-concurrency guard raised, off either channel the
// editor uses: Eden's error field on a direct call, or the `APIError`
// `unwrapEden` throws inside a mutation.
const isEdenVersionConflict = (error: ApiErrorInput): boolean =>
  normalizeApiError(error).code === API_VERSION_CONFLICT_ERROR_CODE;

const isThrownVersionConflict = (error: unknown): boolean =>
  APIError.is(error) && error.code === API_VERSION_CONFLICT_ERROR_CODE;

const isNotFound = (error: unknown): boolean =>
  APIError.is(error) && error.status === 404;

/** Title plus localized detail, shared by the toast and conflict paths. */
type ToastFailure = { title: string; description: string };

// ── Root component ────────────────────────────────────

/**
 * The page's product-tour targets, supplied by the route that runs the tour.
 * The pane has none: a second copy of a target would confuse the tour.
 */
type PlaybookEditorTourAnchors = {
  /** The back button; `isDirty` marks it unsafe for the tour to press. */
  back: (isDirty: boolean) => TourAttributes;
  basics: TourAttributes;
  addPosition: TourAttributes;
};

const NO_TOUR_ANCHORS: PlaybookEditorTourAnchors = {
  back: () => ({}),
  basics: {},
  addPosition: {},
};

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

/**
 * Where the editor runs. Everything that differs between the two hosts is
 * derived from this one value.
 *
 * - `page`: the Knowledge page. Explicit Save, a back button, the breadcrumb,
 *   a route navigation blocker, product-tour anchors, and a version-conflict
 *   toast.
 * - `pane`: an inspector tab beside a chat. A draft saves itself after a
 *   pause in editing; a newer server version is merged into the user's edits
 *   instead of raising a conflict; the tab header closes it.
 */
type PlaybookEditorHost =
  | {
      type: "page";
      onBack: () => void;
      onSaved: () => void;
      tourAnchors: PlaybookEditorTourAnchors;
    }
  | {
      type: "pane";
      tabId: string;
      /** Read on unmount: a closed tab discards its parked state. */
      isTabOpen: (tabId: string) => boolean;
      onClose: () => void;
    };

type PlaybookEditorProps = {
  organizationId: string;
  playbookId: string | null;
  host: PlaybookEditorHost;
};

export const PlaybookEditor = ({
  organizationId,
  playbookId,
  host,
}: PlaybookEditorProps) => {
  if (playbookId === null) {
    return (
      <PlaybookEditorForm
        host={host}
        organizationId={organizationId}
        playbookId={null}
        server={NEW_PLAYBOOK_SNAPSHOT}
      />
    );
  }

  return (
    <PlaybookEditorLoader
      host={host}
      organizationId={organizationId}
      playbookId={playbookId}
    />
  );
};

/** Leaving the editor: back to the list on the page, closing the tab in
 *  the pane. */
const leaveEditor = (host: PlaybookEditorHost) => {
  switch (host.type) {
    case "page":
      host.onBack();
      return;
    case "pane":
      host.onClose();
      return;
    default:
      host satisfies never;
      panic(`Unhandled playbook editor host: ${String(host)}`);
  }
};

const PlaybookEditorLoader = ({
  organizationId,
  playbookId,
  host,
}: {
  organizationId: string;
  playbookId: string;
  host: PlaybookEditorHost;
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
  const detailQuery = useQuery({
    ...detailOptions,
    refetchInterval: ({ state }) =>
      host.type !== "pane" || isNotFound(state.error)
        ? false
        : OPEN_EDITOR_REFETCH_INTERVAL_MS,
  });
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

  const leaveButton = (
    <Button onClick={() => leaveEditor(host)} variant="ghost">
      {host.type === "page" ? t("common.goBack") : t("common.close")}
    </Button>
  );

  // Deleted elsewhere (another editor, a chat, the CLI): the form has
  // nothing left to save to.
  if (isNotFound(detailQuery.error)) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 p-8"
        role="status"
      >
        <p className="text-muted-foreground text-sm">
          {t("knowledge.playbooks.deletedElsewhere")}
        </p>
        {leaveButton}
      </div>
    );
  }

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
          {leaveButton}
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
        host={host}
        key={seedState.reloadKey}
        // Derived from the org's findings on every read, so it tracks the cache.
        positionDecisions={readPositionDecisions(detail.positionDecisions)}
        // Looked up for this reader on every read, like the decisions above.
        positionSources={toPositionSourceLookup(detail.positionSources)}
        onReload={reload}
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

// Long enough that typing a sentence does not save once per word; short
// enough that the model's next read sees what the user just changed.
const AUTOSAVE_DELAY_MS = 2000;

type SaveRequestState = "idle" | "in-flight" | "failed";

/** What the form starts from: a parked pane state, or a server version. */
type FormSeed = Omit<ParkedPlaybookPane, "playbookId">;

type SeedFromServerArgs = { server: PlaybookSnapshot; isNew: boolean };

const seedFromServer = ({ server, isNew }: SeedFromServerArgs): FormSeed => {
  // A New Playbook form starts with one empty card the server never carried;
  // the baseline includes it, so the form starts clean.
  const positions =
    isNew && server.draft.positions.length === 0
      ? [newGradedPosition()]
      : server.draft.positions;
  const draft = { ...server.draft, positions };
  return {
    draft,
    updatedAt: server.updatedAt,
    baseline: createPlaybookBaseline(draft),
    status: server.status,
    approvedAt: server.approvedAt,
    openIds: new Set(positions.slice(0, 1).map((p) => p.sourceId)),
    revealedIds: new Set(),
    requiresLeaveConfirmation: false,
    scrollTop: 0,
  };
};

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
  host: PlaybookEditorHost;
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
  host,
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
  const scrollTopRef = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // The page and a pane can show the same playbook at once, so field ids are
  // scoped to this form.
  const fieldIdPrefix = useId();
  const nameId = `${fieldIdPrefix}-name`;
  const descriptionId = `${fieldIdPrefix}-description`;
  const documentTypeId = `${fieldIdPrefix}-document-type`;
  const navigationLeaveRequestedRef = useRef(false);
  const tourAnchors = host.type === "page" ? host.tourAnchors : NO_TOUR_ANCHORS;

  // A pane that was left for another inspector tab comes back as it was.
  const [initial] = useState(() =>
    host.type === "pane" && playbookId !== null
      ? (readParkedPlaybookPane(host.tabId, playbookId) ??
        seedFromServer({ server, isNew: false }))
      : seedFromServer({ server, isNew: playbookId === null }),
  );
  // The token and the baseline share one state because they move together:
  // on this form's own saves, or with the content when the form takes a newer
  // server version. A token that moved alone would pair with a stale draft,
  // and the next save, a full replace, would silently drop the other writer's
  // change instead of meeting the version conflict.
  const [persisted, setPersisted] = useState(() => ({
    updatedAt: initial.updatedAt,
    baseline: initial.baseline,
  }));
  const updatedAt = persisted.updatedAt;
  const baseline = persisted.baseline;
  const [name, setName] = useState(initial.draft.name);
  const [description, setDescription] = useState(initial.draft.description);
  const [perspective, setPerspective] = useState(initial.draft.perspective);
  const [trigger, setTrigger] = useState(initial.draft.trigger);
  const [status, setStatus] = useState(initial.status);
  const [approvedAt, setApprovedAt] = useState(initial.approvedAt);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [positions, setPositions] = useState(initial.draft.positions);
  const [openIds, setOpenIds] = useState(initial.openIds);
  // Cards that show their errors before any save attempt (see
  // `revealErrorsOnLeave`).
  const [revealedIds, setRevealedIds] = useState(initial.revealedIds);
  const editedIdsRef = useRef(new Set<string>());
  const undoToastIdsRef = useRef<string[]>([]);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveRequest, setSaveRequest] = useState<SaveRequestState>("idle");
  // A playbook being deleted takes no more autosaves.
  const deletingRef = useRef(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  // Non-null while confirming a graded → extract conversion that would drop
  // authored tiers.
  const [convertConfirmId, setConvertConfirmId] = useState<string | null>(null);
  // Which document type this playbook runs for (null = every document). A
  // files-table run gates the materialized columns on the Document Type
  // classifier, so this is what makes "a different playbook per type" work.
  const [documentTypeKey, setDocumentTypeKey] = useState(
    initial.draft.documentTypeKey,
  );
  const documentTypesDataQuery = useQuery(documentTypesOptions(organizationId));
  const documentTypesDataView = useQueryView(documentTypesDataQuery);
  useQueryViewError(documentTypesDataView);
  const documentTypesData =
    documentTypesDataView.type === "items"
      ? documentTypesDataView.items
      : undefined;
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

  /** Takes a server version's token and baseline, with `next` as the draft. */
  const adoptServerVersion = (next: PlaybookDraft) => {
    setName(next.name);
    setDescription(next.description);
    setDocumentTypeKey(next.documentTypeKey);
    setPerspective(next.perspective);
    setTrigger(next.trigger);
    setPositions(next.positions);
    setPersisted({
      updatedAt: server.updatedAt,
      baseline: createPlaybookBaseline(server.draft),
    });
    setStatus(server.status);
    setApprovedAt(server.approvedAt);
  };

  // Another writer (a chat, an agent, a second editor) saved a newer version.
  // A form without edits takes it in place: cards are keyed by `sourceId`, so
  // expanded cards and scroll position hold. A form with edits rebases them
  // onto it in the pane; on the page it keeps them and its next save meets
  // the version conflict. Setting state during render settles before paint.
  const serverFollow = resolveServerFollow({
    formUpdatedAt: updatedAt,
    serverUpdatedAt: server.updatedAt,
    isDirty,
  });
  const adopted = draftToAdopt({
    follow: serverFollow,
    whenBehind: host.type === "pane" ? "rebase" : "keep",
    baseline: baseline.draft,
    local: draft,
    server: server.draft,
  });
  if (adopted !== null) {
    adoptServerVersion(adopted);
  }

  const navigationBlocker = useUnsavedWork({
    surface: "playbook-editor",
    // The pane closes with its tab rather than on navigation; only a browser
    // close or hard reload would lose its unsaved work.
    ...(host.type === "page"
      ? { guard: "confirm-navigation" }
      : { guard: "unload" }),
    isDirty,
  });

  const onBack = host.type === "page" ? host.onBack : null;
  const requestBack = useCallback(() => {
    if (onBack === null) {
      return;
    }
    if (isDirty) {
      setLeaveConfirmOpen(true);
      return;
    }
    onBack();
  }, [isDirty, onBack, setLeaveConfirmOpen]);

  // Publish the open playbook to the breadcrumb (Knowledge › Playbooks › Name)
  // and wire its list crumb back through the in-page back affordance. The
  // pane sits beside another page and does not own its breadcrumb.
  useExternalSyncEffect(() => {
    if (host.type !== "page") {
      return undefined;
    }
    setNavOpen({
      id: playbookId ?? "new",
      name: displayName,
      exit: requestBack,
    });
    return () => clearNav();
  }, [host.type, playbookId, displayName, requestBack, setNavOpen, clearNav]);

  const invalidIds = invalidPositionIds({
    positions,
    persistedIds: baseline.persistedIds,
  });
  const invalidIdSet = new Set(invalidIds);
  const nameMissing = name.trim() === "";
  const errorsById = new Map(
    positions.map((position): [string, PositionErrors] => [
      position.sourceId,
      invalidIdSet.has(position.sourceId) ? validatePosition(position) : {},
    ]),
  );
  const autosaves = canAutosave({
    host: host.type,
    exists: playbookId !== null,
    status,
    canUpdate: canSave,
  });

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
    scheduleAutosave();
    editedIdsRef.current.add(sourceId);
    setPositions((prev) =>
      prev.map((p) => (p.sourceId === sourceId ? next : p)),
    );
  };

  // In the pane, a card's errors show once the user has edited it and moved
  // on; a card just added stays quiet until then.
  const revealErrorsOnLeave = (sourceId: string) => {
    if (host.type !== "pane" || !editedIdsRef.current.has(sourceId)) {
      return;
    }
    setRevealedIds((prev) =>
      prev.has(sourceId) ? prev : new Set(prev).add(sourceId),
    );
  };

  const removePosition = (sourceId: string) => {
    scheduleAutosave();
    const index = positions.findIndex((p) => p.sourceId === sourceId);
    const removed = positions[index];
    setPositions((prev) => prev.filter((p) => p.sourceId !== sourceId));
    // The pane autosaves the removal, so it offers an undo.
    if (host.type !== "pane" || removed === undefined) {
      return;
    }
    undoToastIdsRef.current.push(
      stellaToast.add({
        title: t("knowledge.playbooks.positionRemoved"),
        timeout: POSITION_REMOVED_TOAST_TIMEOUT_MS,
        actionProps: {
          children: t("common.undo"),
          onClick: () => {
            scheduleAutosave();
            setPositions((prev) =>
              prev.some((p) => p.sourceId === sourceId)
                ? prev
                : prev.toSpliced(Math.min(index, prev.length), 0, removed),
            );
          },
        },
      }),
    );
  };

  const addPosition = (mode: "graded" | "extract") => {
    scheduleAutosave();
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
    scheduleAutosave();
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
    scheduleAutosave();
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
    scheduleAutosave();
    setPositions((prev) => {
      const index = prev.findIndex((p) => p.sourceId === sourceId);
      return moveAdjacent(prev, index, direction) ?? prev;
    });
  };

  const jumpToPosition = (sourceId: string) => {
    setOpen(sourceId, true);
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[data-position-id="${CSS.escape(sourceId)}"]`,
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
      setPersisted((current) => ({ ...current, updatedAt: fresh.updatedAt }));
    }
  };

  /**
   * A 409 means someone else moved the definition.
   *
   * On the page, refetch and take the fresh token (the one place it moves
   * without the content): the user has now been told, so their next save is a
   * deliberate overwrite rather than the same rejection again. Also offer a
   * reload that swaps in the server's copy instead of leaving a toast the
   * user can only re-trigger.
   *
   * In the pane, refetch: the form rebases onto the newer version. When the
   * pane autosaves, the rebased draft saves by itself. An approval or an
   * explicit Save is not repeated, so the pane says that it did not happen.
   */
  const reportVersionConflict = (
    failure: ToastFailure,
    refused: "save" | "approval",
  ) => {
    if (host.type === "pane") {
      if (playbookId !== null) {
        detached(
          refetchSupersededDetail(
            queryClient,
            playbookDetailOptions(organizationId, playbookId).queryKey,
          ).then(() => scheduleAutosave()),
          "playbook-editor.refetch-for-rebase",
        );
      }
      if (refused === "approval" || !autosaves) {
        notifyUserError(undefined, failure.title, {
          description: failure.description,
        });
      }
      return;
    }
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

  /**
   * Sends one save and records its outcome. Shared by the Save button and
   * autosave; only the toasts around it differ.
   */
  const sendSave = async ({
    savedDraft,
    expectedUpdatedAt,
  }: SendSaveArgs): Promise<SaveOutcome> => {
    // The one place the save body is built — the same builder the dirty
    // check fingerprints, so a field can never be saved without being tracked.
    const payload = buildPlaybookSavePayload({
      draft: savedDraft,
      persistedIds: baseline.persistedIds,
    });
    // Each branch awaits its own Eden call and inspects `.error` before
    // touching `.data`: Eden resolves rather than throwing, so a failed
    // request reads as success anywhere the response is not checked.
    const response =
      playbookId === null
        ? await api.playbooks.post(payload)
        : await api
            .playbooks({
              playbookId: toSafeId<"playbookDefinition">(playbookId),
            })
            // Sent whenever the editor has a token: a save that would clobber
            // someone else's is refused rather than silently winning.
            .put({
              ...payload,
              ...(expectedUpdatedAt === null ? {} : { expectedUpdatedAt }),
            });
    if (response.error) {
      return isEdenVersionConflict(response.error)
        ? { type: "conflict", error: response.error }
        : { type: "failed", error: response.error };
    }
    const savedAt =
      "updatedAt" in response.data ? response.data.updatedAt : null;
    // What was just persisted is the new clean state; the draft may have moved
    // on during the request, and comparing against this snapshot keeps those
    // later keystrokes dirty. A newer token a rebase already took stays.
    setPersisted((current) =>
      resolveSavedPlaybookState({ current, savedAt, savedDraft }),
    );
    // Every update returns the playbook to draft.
    setStatus("draft");
    setApprovedAt(null);
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.playbooks.all(organizationId),
      }),
      "playbook-editor.invalidate",
    );
    return { type: "saved", updatedAt: savedAt };
  };

  const saveFailure = (error: ApiErrorInput): ToastFailure => ({
    title: t("knowledge.playbooks.saveFailed"),
    description: userErrorMessage(error, t("common.unexpectedError")),
  });

  const notifySaveFailed = (error: ApiErrorInput) => {
    const failure = saveFailure(error);
    notifyUserError(toAPIError(error), failure.title, {
      description: failure.description,
    });
  };

  const revealInvalidPositions = () => {
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
    const first = invalidIds.at(0);
    if (first !== undefined) {
      jumpToPosition(first);
    }
  };

  /** The pane's "not saved" status, pressed: shows what holds the save. */
  const showProblems = () => {
    revealInvalidPositions();
    if (nameMissing && invalidIds.length === 0) {
      nameInputRef.current?.focus();
    }
  };

  /** The Save button: validates with toasts, then saves. */
  const handleSave = async (): Promise<boolean> => {
    if (nameMissing) {
      setAttemptedSave(true);
      notifyUserError(undefined, t("knowledge.playbooks.nameRequired"));
      return false;
    }
    if (invalidIds.length > 0) {
      revealInvalidPositions();
      notifyUserError(
        undefined,
        t("knowledge.playbooks.fixErrorsBeforeSaving"),
      );
      return false;
    }

    setSaving(true);
    const { outcome } = await queueSave(draft);
    setSaving(false);
    switch (outcome.type) {
      case "saved":
        stellaToast.add({
          type: "success",
          title: isEdit
            ? t("knowledge.playbooks.updated")
            : t("knowledge.playbooks.created"),
        });
        return true;
      case "conflict":
        reportVersionConflict(saveFailure(outcome.error), "save");
        return false;
      case "failed":
        notifySaveFailed(outcome.error);
        return false;
      default:
        outcome satisfies never;
        return panic(`Unhandled save outcome: ${String(outcome)}`);
    }
  };

  const {
    queueSave,
    flushOnLeave: queueFinalDraft,
    hasPendingSave,
  } = usePlaybookSaveQueue({ updatedAt, sendSave });

  const isAutosaveDue = () =>
    !deletingRef.current &&
    autosaves &&
    (isDirty || hasPendingSave()) &&
    !nameMissing &&
    invalidIds.length === 0;

  /** Saves the pane's draft. The status line reports it; only a failure
   *  also raises a toast. */
  const runAutosave = async () => {
    if (!isAutosaveDue()) {
      return;
    }
    setSaveRequest("in-flight");
    const { outcome, isLatest } = await queueSave(draft);
    switch (outcome.type) {
      case "saved":
        break;
      case "conflict":
        reportVersionConflict(saveFailure(outcome.error), "save");
        break;
      case "failed":
        notifySaveFailed(outcome.error);
        break;
      default:
        outcome satisfies never;
        panic(`Unhandled save outcome: ${String(outcome)}`);
    }
    if (isLatest) {
      setSaveRequest(outcome.type === "failed" ? "failed" : "idle");
    }
  };

  const scheduleAutosave = useDebouncedCallback(() => {
    detached(runAutosave(), "playbook-editor.autosave");
  }, AUTOSAVE_DELAY_MS);

  usePlaybookDetailSaveSubscription({
    queryClient,
    queryKey:
      host.type === "pane" && playbookId !== null
        ? playbookDetailOptions(organizationId, playbookId).queryKey
        : null,
    onSaved: scheduleAutosave,
  });

  /**
   * Saves the draft as the pane unmounts, after any save still in flight.
   * The status line is gone by then, so a failure is a toast.
   */
  const flushOnLeave = async () => {
    const request = queueFinalDraft({
      draft,
      isDirty,
      canSaveDraft:
        !deletingRef.current &&
        autosaves &&
        !nameMissing &&
        invalidIds.length === 0,
    });
    if (request === null) {
      return;
    }
    const { outcome } = await request;
    if (outcome.type !== "saved") {
      notifySaveFailed(outcome.error);
    }
  };

  const requiresLeaveConfirmation = useLatestCallback(
    () => isDirty && (!autosaves || nameMissing || invalidIds.length > 0),
  );

  useMountEffect(() => {
    if (host.type !== "pane" || playbookId === null) {
      return;
    }
    return registerPlaybookPaneLeaveGuard({
      tabId: host.tabId,
      playbookId,
      shouldConfirm: requiresLeaveConfirmation,
    });
  });

  // The pane unmounts whenever another inspector tab is opened or the pane
  // is minimized. It saves what it can, and parks the rest unless the tab
  // itself was closed.
  const leavePane = useLatestCallback(() => {
    if (host.type !== "pane" || playbookId === null) {
      return;
    }
    scheduleAutosave.cancel();
    // Undo restores a position into this form, so its toasts go with it.
    for (const toastId of undoToastIdsRef.current) {
      stellaToast.close(toastId);
    }
    detached(flushOnLeave(), "playbook-editor.flush-on-leave");
    if (!host.isTabOpen(host.tabId)) {
      discardParkedPlaybookPane(host.tabId);
      return;
    }
    parkPlaybookPane({
      tabId: host.tabId,
      isTabOpen: host.isTabOpen,
      state: {
        playbookId,
        draft,
        updatedAt,
        baseline,
        status,
        approvedAt,
        openIds,
        revealedIds,
        requiresLeaveConfirmation: requiresLeaveConfirmation(),
        scrollTop: scrollTopRef.current,
      },
    });
  });

  useMountEffect(() => {
    if (scrollRef.current !== null && initial.scrollTop > 0) {
      scrollRef.current.scrollTop = initial.scrollTop;
    }
    if (host.type === "pane" && isDirty && autosaves) {
      scheduleAutosave();
    }
    return () => leavePane();
  });

  /**
   * Runs the save and hands the outcome to `after`. The three "save now"
   * affordances (toolbar, in-page leave, and navigation block) each follow up
   * differently but must not each re-derive the await dance. Callers detach
   * the returned promise under their own label.
   */
  const saveThen = async (after: (saved: boolean) => void) => {
    after(await handleSave());
  };

  const leaveIfSaved = (saved: boolean) => {
    if (saved && host.type === "page") {
      host.onSaved();
    }
  };

  const handleDelete = async () => {
    if (playbookId === null) {
      return;
    }
    setSaving(true);
    deletingRef.current = true;
    const response = await api
      .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
      .delete();
    setSaving(false);

    if (response.error) {
      deletingRef.current = false;
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
    if (host.type === "page") {
      host.onSaved();
    } else {
      host.onClose();
    }
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
      setPersisted((current) => ({ ...current, updatedAt: data.updatedAt }));
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
        reportVersionConflict(failure, "approval");
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
      // Read when the pane parks: the node is detached before unmount
      // cleanup runs.
      onScroll={(event) => {
        scrollTopRef.current = event.currentTarget.scrollTop;
      }}
      ref={scrollRef}
    >
      <div className="mx-auto flex w-full max-w-5xl gap-8 p-4 @lg:p-6">
        <div className="min-w-0 flex-1 space-y-6">
          <PlaybookEditorToolbar
            // The pane's save status stands in for the Save button and warns
            // before a close loses edits, so it stays in view while scrolling.
            className={cn(
              host.type === "pane" && "bg-background sticky top-0 z-10 py-2",
            )}
            approvedAt={approvedAt}
            approving={approveMutation.isPending}
            busy={saving}
            canApprove={canApprove}
            canDelete={canDelete}
            deleteOpen={deleteOpen}
            isDirty={isDirty}
            isEdit={isEdit}
            onApprove={handleApprove}
            backTourAttributes={tourAnchors.back(isDirty)}
            onBack={onBack === null ? null : requestBack}
            onDelete={() => {
              detached(handleDelete(), "playbook-editor.delete");
            }}
            onDeleteOpenChange={setDeleteOpen}
            onOpenVersionHistory={() => setVersionHistoryOpen(true)}
            save={
              autosaves
                ? {
                    type: "autosave",
                    status: resolvePaneSaveStatus({
                      isDirty,
                      request: saveRequest,
                      nameMissing,
                      invalidPositions: invalidIds.length,
                    }),
                    onRetry: () => {
                      detached(runAutosave(), "playbook-editor.autosave-retry");
                    },
                    onShowProblems: showProblems,
                  }
                : {
                    type: "button",
                    disabled: !canSave || !isDirty || saving,
                    loading: saving,
                    onSave: () => {
                      detached(saveThen(leaveIfSaved), "playbook-editor.save");
                    },
                  }
            }
            status={status}
          />

          {/* Once the fresher copy has loaded, a form without edits has already
              followed it; the notice stays only over unsaved edits. */}
          {staleDetail !== undefined &&
            (staleDetail.fresher !== "loaded" || serverFollow === "behind") && (
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

          <div className="space-y-6" {...tourAnchors.basics}>
            <div className="grid gap-1.5">
              <Label htmlFor={nameId}>{t("common.name")}</Label>
              <Input
                aria-invalid={attemptedSave && name.trim() === ""}
                id={nameId}
                onChange={(e) => {
                  setName(e.target.value);
                  scheduleAutosave();
                }}
                ref={nameInputRef}
                placeholder={t("knowledge.playbooks.namePlaceholder")}
                value={name}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={descriptionId}>{t("common.description")}</Label>
              <Textarea
                className="min-h-[60px]"
                id={descriptionId}
                onChange={(e) => {
                  setDescription(e.target.value);
                  scheduleAutosave();
                }}
                placeholder={t("knowledge.playbooks.descriptionPlaceholder")}
                value={description}
              />
            </div>

            <QueryViewFeedback view={documentTypesDataView} />
            {documentTypes.length > 0 && (
              <div className="grid gap-1.5">
                <Label htmlFor={documentTypeId}>{t("common.type")}</Label>
                <Select
                  onValueChange={(next) => {
                    scheduleAutosave();
                    setDocumentTypeKey(
                      next === null || next === SCOPE_ALL_VALUE ? null : next,
                    );
                  }}
                  value={documentTypeKey ?? SCOPE_ALL_VALUE}
                >
                  <SelectTrigger id={documentTypeId}>
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
              <AddPositionMenu
                onAdd={addPosition}
                tourAttributes={tourAnchors.addPosition}
              />
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
                    onFocusLeave={() => revealErrorsOnLeave(position.sourceId)}
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
                    showErrors={
                      attemptedSave || revealedIds.has(position.sourceId)
                    }
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
            detached(saveThen(leaveIfSaved), "playbook-editor.save-and-leave");
          },
        }}
        secondary={{
          label: t("knowledge.playbooks.discardChanges"),
          onClick: () => leaveEditor(host),
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

// ── Add-position menu (graded vs extract) ─────────────

const AddPositionMenu = ({
  onAdd,
  tourAttributes,
}: {
  onAdd: (mode: "graded" | "extract") => void;
  tourAttributes: TourAttributes;
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
            {...tourAttributes}
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
  positions: readonly Position[];
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
