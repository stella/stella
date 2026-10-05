import { useCallback, useRef, useState } from "react";

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
import { LeaveConfirmDialog } from "@/features/knowledge/leave-confirm-dialog";
import type {
  FresherDetail,
  PlaybookDraft,
  PaneSaveStatus,
  PlaybookSnapshot,
  PositionSourceLookup,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import {
  canAutosave,
  buildPlaybookSavePayload,
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
  hasResolvedPositionSources,
  detailSeedGate,
  invalidPositionIds,
  draftToAdopt,
  latchedSeedGate,
  refetchSupersededDetail,
  resolveDetailSeed,
  resolvePaneSaveStatus,
  resolvePlaybookScrollTop,
  resolvePositionSources,
  resolveServerFollow,
  toPositionSourceLookup,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import {
  discardParkedPlaybookPane,
  parkPlaybookPane,
  readParkedPlaybookPane,
} from "@/features/knowledge/playbook-editor/playbook-pane-parking";
import type { ParkedPlaybookPane } from "@/features/knowledge/playbook-editor/playbook-pane-parking";
import { PlaybookVersionHistorySheet } from "@/features/knowledge/playbook-editor/playbook-version-history-sheet";
import { PositionEditor } from "@/features/knowledge/playbook-editor/position-editor";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
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

/** `data-*` attributes a product tour marks its targets with. */
type TourAttributes = Readonly<Partial<Record<`data-${string}`, string>>>;

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
          <Button onClick={() => leaveEditor(host)} variant="ghost">
            {host.type === "page" ? t("common.goBack") : t("common.close")}
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

// ── Toolbar ───────────────────────────────────────────

type PaneSaveStatusProps = {
  status: PaneSaveStatus;
  onRetry: () => void;
  onShowProblems: () => void;
};

/**
 * Stands in for the Save button while the pane autosaves. "Saving" stays
 * quiet however long it takes: a save can wait on a model deriving asks.
 */
const PaneSaveStatusContent = ({
  status,
  onRetry,
  onShowProblems,
}: PaneSaveStatusProps) => {
  const t = useTranslations();
  switch (status.type) {
    case "saved":
      return <span className="text-muted-foreground">{t("common.saved")}</span>;
    case "saving":
      return (
        <span className="text-muted-foreground">{t("common.saving")}</span>
      );
    case "failed":
      return (
        <>
          <span className="text-destructive">
            {t("knowledge.playbooks.autosave.failed")}
          </span>
          <Button onClick={onRetry} size="xs" type="button" variant="ghost">
            {t("common.retry")}
          </Button>
        </>
      );
    case "needs-attention":
      return (
        <Button
          onClick={onShowProblems}
          size="xs"
          type="button"
          variant="ghost"
        >
          {status.invalidPositions > 0
            ? t("knowledge.playbooks.autosave.positionsNeedAttention", {
                count: status.invalidPositions,
              })
            : t("knowledge.playbooks.autosave.nameMissing")}
        </Button>
      );
    default:
      status satisfies never;
      return panic(`Unhandled pane save status: ${String(status)}`);
  }
};

/** The save control: a Save button, or the pane's autosave status. */
type ToolbarSave =
  | { type: "button"; disabled: boolean; loading: boolean; onSave: () => void }
  | ({ type: "autosave" } & PaneSaveStatusProps);

type PlaybookEditorToolbarProps = {
  /** Null in the pane, whose tab header closes it. */
  onBack: (() => void) | null;
  backTourAttributes: TourAttributes;
  isEdit: boolean;
  isDirty: boolean;
  status: PlaybookApprovalStatus;
  approvedAt: string | null;
  canApprove: boolean;
  canDelete: boolean;
  approving: boolean;
  onApprove: () => void;
  onOpenVersionHistory: () => void;
  deleteOpen: boolean;
  onDeleteOpenChange: (open: boolean) => void;
  /** A save or delete request is running. */
  busy: boolean;
  onDelete: () => void;
  save: ToolbarSave;
};

const PlaybookEditorToolbar = ({
  onBack,
  backTourAttributes,
  isEdit,
  isDirty,
  status,
  approvedAt,
  canApprove,
  canDelete,
  approving,
  onApprove,
  onOpenVersionHistory,
  deleteOpen,
  onDeleteOpenChange,
  busy,
  onDelete,
  save,
}: PlaybookEditorToolbarProps) => {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {onBack !== null && (
        <Button
          onClick={onBack}
          size="sm"
          type="button"
          variant="ghost"
          {...backTourAttributes}
        >
          <ArrowLeftIcon />
          {t("common.back")}
        </Button>
      )}
      <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
        {isEdit && (
          <PlaybookStatusBadge approvedAt={approvedAt} status={status} />
        )}
        {isDirty && save.type === "button" && (
          <span className="text-muted-foreground text-xs">
            {t("knowledge.playbooks.unsavedChanges")}
          </span>
        )}
        {isEdit && (
          <Button
            onClick={onOpenVersionHistory}
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
            disabled={isDirty || approving}
            loading={approving}
            onClick={onApprove}
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
          <AlertDialog onOpenChange={onDeleteOpenChange} open={deleteOpen}>
            <Button
              aria-label={t("knowledge.playbooks.deletePlaybook")}
              onClick={() => onDeleteOpenChange(true)}
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
                  disabled={busy}
                  onClick={onDelete}
                  variant="destructive"
                >
                  {t("common.delete")}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
        {save.type === "autosave" ? (
          <div aria-live="polite" className="flex items-center gap-1 text-xs">
            <PaneSaveStatusContent
              onRetry={save.onRetry}
              onShowProblems={save.onShowProblems}
              status={save.status}
            />
          </div>
        ) : (
          <Button
            disabled={save.disabled}
            loading={save.loading}
            onClick={save.onSave}
            type="button"
          >
            {t("common.save")}
          </Button>
        )}
      </div>
    </div>
  );
};

// ── Editor form ───────────────────────────────────────

// Long enough that typing a sentence does not save once per word; short
// enough that the model's next read sees what the user just changed.
const AUTOSAVE_DELAY_MS = 2000;

type SaveRequestState = "idle" | "in-flight" | "failed";

type SaveOutcome =
  | { type: "saved"; updatedAt: string | null }
  | { type: "conflict"; error: ApiErrorInput }
  | { type: "failed"; error: ApiErrorInput };

/** A save placed behind any save in flight; `outcome` is the queue's tail. */
type QueuedSave = { outcome: Promise<SaveOutcome> };

type SendSaveArgs = {
  savedDraft: PlaybookDraft;
  expectedUpdatedAt: string | null;
};

/** What the form starts from: a parked pane state, or a server version. */
type FormSeed = Omit<ParkedPlaybookPane, "playbookId">;

type SeedFromServerArgs = { server: PlaybookSnapshot; isNew: boolean };

const seedFromServer = ({ server, isNew }: SeedFromServerArgs): FormSeed => {
  // A New Playbook form starts with one empty card the server never carried;
  // the baseline includes it, so the form starts clean.
  const positions =
    isNew && server.draft.positions.length === 0
      ? [newGradedPosition()]
      : [...server.draft.positions];
  const draft = { ...server.draft, positions };
  return {
    draft,
    updatedAt: server.updatedAt,
    baseline: createPlaybookBaseline(draft),
    status: server.status,
    approvedAt: server.approvedAt,
    openIds: new Set(positions.slice(0, 1).map((p) => p.sourceId)),
    revealedIds: new Set(),
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
  const navigationLeaveRequestedRef = useRef(false);
  const tourAnchors = host.type === "page" ? host.tourAnchors : NO_TOUR_ANCHORS;

  // A pane that was left for another inspector tab comes back as it was.
  const [initial] = useState(() =>
    host.type === "pane" && playbookId !== null
      ? (readParkedPlaybookPane(host.tabId, playbookId) ??
        seedFromServer({ server, isNew: false }))
      : seedFromServer({ server, isNew: playbookId === null }),
  );
  // The token stays with the draft it was read with, so it shares one state
  // with the baseline: both move on this form's own writes, or together with
  // the content when the form follows or rebases onto a newer server version
  // (see `resolveServerFollow`). Were the token to move alone, a refetch
  // under the form (a chat save, another editor, a window refocus) would pair
  // a fresh token with a stale draft, and the next save, a full replace,
  // would silently drop the change that moved it instead of meeting the
  // version conflict. The baseline is the clean state every later draft is
  // measured against; its fingerprint is computed once per baseline.
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
  const [positions, setPositions] = useState(() => [
    ...initial.draft.positions,
  ]);
  const [openIds, setOpenIds] = useState(initial.openIds);
  // Cards whose errors show although no save was attempted: the user edited
  // them and moved on. The pane has no Save press to reveal errors.
  const [revealedIds, setRevealedIds] = useState(initial.revealedIds);
  const editedIdsRef = useRef(new Set<string>());
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveRequest, setSaveRequest] = useState<SaveRequestState>("idle");
  const inFlightSaveRef = useRef<Promise<SaveOutcome> | null>(null);
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

  /** Takes a server version's token and baseline, with `next` as the draft. */
  const adoptServerVersion = (next: PlaybookDraft) => {
    const nextPositions = [...next.positions];
    setName(next.name);
    setDescription(next.description);
    setDocumentTypeKey(next.documentTypeKey);
    setPerspective(next.perspective);
    setTrigger(next.trigger);
    setPositions(nextPositions);
    setPersisted({
      updatedAt: server.updatedAt,
      baseline: createPlaybookBaseline(
        next === server.draft
          ? { ...server.draft, positions: nextPositions }
          : server.draft,
      ),
    });
    setStatus(server.status);
    setApprovedAt(server.approvedAt);
  };

  // Another writer (a chat, an agent, a second editor) saved a newer version.
  // A form without edits takes it in place: cards are keyed by `sourceId`,
  // which saves keep stable, so expanded cards and scroll position hold. In
  // the pane, edits are rebased onto it, so both the user's edits and the
  // other writer's save survive. On the page, edits stay and the next save
  // meets the version conflict. Adjusting state during render settles in the
  // same pass, before paint.
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

  const invalidIds = invalidPositionIds(positions);
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
    const index = positions.findIndex((p) => p.sourceId === sourceId);
    const removed = positions[index];
    setPositions((prev) => prev.filter((p) => p.sourceId !== sourceId));
    // The pane saves the removal a moment later and a draft save keeps no
    // version, so it offers the undo the page's explicit Save stands in for.
    if (host.type !== "pane" || removed === undefined) {
      return;
    }
    stellaToast.add({
      title: t("knowledge.playbooks.positionRemoved"),
      actionProps: {
        children: t("common.undo"),
        onClick: () =>
          setPositions((prev) =>
            prev.some((p) => p.sourceId === sourceId)
              ? prev
              : prev.toSpliced(Math.min(index, prev.length), 0, removed),
          ),
      },
    });
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
      setPersisted((current) => ({ ...current, updatedAt: fresh.updatedAt }));
    }
  };

  /**
   * A 409 means someone else moved the definition. On the page, refetch and
   * take the fresh token alone (the one place it moves without the content):
   * the user has now been told, so their next save is a deliberate overwrite
   * rather than the same rejection again. Also offer a reload that swaps in
   * the server's copy instead of leaving a toast the user can only
   * re-trigger. In the pane, the refetch alone is enough: the newer version
   * arrives through the loader and the form rebases onto it.
   */
  const reportVersionConflict = (failure: ToastFailure) => {
    if (playbookId === null) {
      return;
    }
    if (host.type === "pane") {
      detached(
        refetchSupersededDetail(
          queryClient,
          playbookDetailOptions(organizationId, playbookId).queryKey,
        ),
        "playbook-editor.refetch-for-rebase",
      );
      return;
    }
    detached(
      takeFreshToken(playbookId),
      "playbook-editor.refetch-after-conflict",
    );
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
   * autosave; only the toasts around it differ. A success never moves the
   * form to an older token: a rebase may already have taken a newer one.
   */
  const sendSave = async ({
    savedDraft,
    expectedUpdatedAt,
  }: SendSaveArgs): Promise<SaveOutcome> => {
    // The one place the save body is built — the same builder the dirty
    // check fingerprints, so a field can never be saved without being tracked.
    const payload = buildPlaybookSavePayload(savedDraft);
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
    // later keystrokes dirty.
    setPersisted((current) =>
      savedAt === null ||
      resolveServerFollow({
        formUpdatedAt: current.updatedAt,
        serverUpdatedAt: savedAt,
        isDirty: false,
      }).type === "reseed"
        ? {
            updatedAt: savedAt,
            baseline: createPlaybookBaseline(savedDraft),
          }
        : current,
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

  /** Expands every invalid card and scrolls to the first, with errors shown. */
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
    const outcome = await sendSave({
      savedDraft: draft,
      expectedUpdatedAt: updatedAt,
    });
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
        reportVersionConflict(saveFailure(outcome.error));
        return false;
      case "failed": {
        const failure = saveFailure(outcome.error);
        notifyUserError(toAPIError(outcome.error), failure.title, {
          description: failure.description,
        });
        return false;
      }
      default:
        outcome satisfies never;
        return panic(`Unhandled save outcome: ${String(outcome)}`);
    }
  };

  /**
   * Queues a save behind any save still in flight, so two never run at once.
   * A queued save expects the token the one before it returned.
   */
  const queueSave = (savedDraft: PlaybookDraft): QueuedSave => {
    const previous = inFlightSaveRef.current;
    const tokenAtCall = updatedAt;
    const request = (async () => {
      const before = previous === null ? null : await previous;
      const expectedUpdatedAt =
        before?.type === "saved" && before.updatedAt !== null
          ? before.updatedAt
          : tokenAtCall;
      return sendSave({ savedDraft, expectedUpdatedAt });
    })();
    inFlightSaveRef.current = request;
    return { outcome: request };
  };

  /** Saves the pane's draft without toasts. */
  const runAutosave = async () => {
    if (!autosaves || !isDirty || nameMissing || invalidIds.length > 0) {
      return;
    }
    setSaveRequest("in-flight");
    const { outcome: request } = queueSave(draft);
    const outcome = await request;
    const isLatest = inFlightSaveRef.current === request;
    if (isLatest) {
      inFlightSaveRef.current = null;
    }
    switch (outcome.type) {
      case "saved":
        break;
      case "conflict":
        // The refetch brings the newer version, the form rebases onto it,
        // and the rebased draft saves after the next pause.
        reportVersionConflict(saveFailure(outcome.error));
        break;
      case "failed": {
        const failure = saveFailure(outcome.error);
        notifyUserError(toAPIError(outcome.error), failure.title, {
          description: failure.description,
        });
        break;
      }
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

  // Pushes the pane's draft to the server after a pause in editing.
  useExternalSyncEffect(() => {
    if (autosaves && isDirty) {
      scheduleAutosave();
    }
  }, [
    autosaves,
    isDirty,
    name,
    description,
    documentTypeKey,
    positions,
    scheduleAutosave,
  ]);

  /**
   * Saves the draft as the pane unmounts, after any save still in flight.
   * The status line is gone by then, so a failure is a toast.
   */
  const flushOnLeave = async () => {
    const outcome = await queueSave(draft).outcome;
    if (outcome.type === "saved") {
      return;
    }
    const failure = saveFailure(outcome.error);
    notifyUserError(toAPIError(outcome.error), failure.title, {
      description: failure.description,
    });
  };

  // The pane unmounts whenever another inspector tab is opened or the pane
  // is minimized. It saves what it can, and parks the rest unless the tab
  // itself was closed.
  const leavePane = useLatestCallback(() => {
    if (host.type !== "pane" || playbookId === null) {
      return;
    }
    scheduleAutosave.cancel();
    if (autosaves && isDirty && !nameMissing && invalidIds.length === 0) {
      detached(flushOnLeave(), "playbook-editor.flush-on-leave");
    }
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
        scrollTop: scrollTopRef.current,
      },
    });
  });

  useMountEffect(() => {
    if (scrollRef.current !== null && initial.scrollTop > 0) {
      scrollRef.current.scrollTop = initial.scrollTop;
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
                      detached(
                        saveThen((saved) => {
                          if (saved && host.type === "page") {
                            host.onSaved();
                          }
                        }),
                        "playbook-editor.save",
                      );
                    },
                  }
            }
            status={status}
          />

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

          <div className="space-y-6" {...tourAnchors.basics}>
            <div className="grid gap-1.5">
              <Label htmlFor="playbook-name">{t("common.name")}</Label>
              <Input
                aria-invalid={attemptedSave && name.trim() === ""}
                id="playbook-name"
                onChange={(e) => setName(e.target.value)}
                ref={nameInputRef}
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

      {onBack !== null && (
        <>
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
                    if (saved && host.type === "page") {
                      host.onSaved();
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
        </>
      )}
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
