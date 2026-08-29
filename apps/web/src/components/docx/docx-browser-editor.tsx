/**
 * DocxBrowserEditor — wrapper that manages the edit session lifecycle
 * and renders the Folio DocxEditor.
 */

import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Result } from "better-result";
import {
  CheckCircle2Icon,
  EyeIcon,
  GitCommitHorizontalIcon,
  LockOpenIcon,
  PenLineIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useFormatter, useTranslations } from "use-intl";

import {
  FolioUIProvider,
  FormattingBar,
  setAnonymizationTermsMeta,
} from "@stll/folio-react";
import type {
  AnonymizationTerm,
  DocxCompatibility,
  DocxEditorCollaboration,
  DocxEditorRef,
  EditorMode,
} from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import {
  Select as StSelect,
  SelectItem as StSelectItem,
  SelectPopup as StSelectPopup,
  SelectTrigger as StSelectTrigger,
  SelectValue as StSelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";
import { composeRefs } from "@stll/ui/utils";

import { useActiveDocxStore } from "@/components/ai-suggestions/active-docx-store";
import type { ActiveDocxRegistrationToken } from "@/components/ai-suggestions/active-docx-store";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { ReviewBar } from "@/components/ai-suggestions/review-bar";
import "@stll/folio-react/editor.css";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import { useAutocompleteStream } from "@/components/autocomplete/use-autocomplete-stream";
import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";
import { DocxEditor } from "@/components/docx/app-docx-editor";
import type { DocxComments } from "@/components/docx/app-docx-editor";
import { DocxFindBar } from "@/components/docx/docx-find-bar";
import { DocxLoadingShell } from "@/components/docx/docx-loading-shell";
import { useDocxBlockScroll } from "@/components/docx/use-docx-block-scroll";
import { useDocxFind } from "@/components/docx/use-docx-find";
import { useFolioCollaborationRoom } from "@/components/docx/use-folio-collaboration-room";
import { useSyncDocxSuggestions } from "@/components/docx/use-sync-docx-suggestions";
import {
  useInspectorAnonymizationStore,
  useIsAnonymizationActive,
} from "@/components/inspector/inspector-anonymization-store";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { RenderStormRegion } from "@/components/render-storm-canary";
import { StatusMessage } from "@/components/route-components";
import { UserIdentityAvatar } from "@/components/user-avatar";
import { env } from "@/env";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { anonymizeChatTextInWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import { api } from "@/lib/api";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { fileOptions } from "@/lib/files/queries";
import { folioUIComponents } from "@/lib/folio-ui-components";
import { getDisplayName } from "@/lib/get-display-name";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { toSafeId } from "@/lib/safe-id";
import "@/components/pdf/peek/peek-docx.css";
import { anonymizationAllowlistOptions } from "@/lib/workspaces/queries/anonymization-allowlist";
import { anonymizationTermsOptions } from "@/lib/workspaces/queries/anonymization-terms";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

import {
  getDocxEditBlockReason,
  getDocxEditSafety,
  selectDocxBrowserEditorBuffer,
  selectPreviewFile,
  shouldFinalizeEditSession,
} from "./docx-browser-editor.logic";
import type { OptimisticPreviewFile } from "./docx-browser-editor.logic";
import {
  aggregateAnonymizationMatches,
  buildAnonymizationDetectionKey,
  buildExcludedCanonicalsSet,
  createTrailingSingleFlight,
  decideAnonymizationDetectionRun,
  dedupeDetectedAnonymizationTerms,
  mergeAnonymizationTerms,
  resolveCheckpointAutosaveStatus,
} from "./docx-edit-mode.logic";
import type { AutosaveStatus } from "./docx-edit-mode.logic";
import type {
  EditSessionErrorReason,
  EditSessionState,
} from "./use-edit-session";
import { useEditSession } from "./use-edit-session";

const CHANGE_CHECKPOINT_DELAY = 2000;
const COLLABORATOR_COLOR_SPACE = 16_777_215;
const noop = () => undefined;

const colorFromStableId = (value: string) => {
  let hash = 0;
  for (const character of value) {
    hash =
      (hash * 31 + (character.codePointAt(0) ?? 0)) % COLLABORATOR_COLOR_SPACE;
  }
  const color = (hash * 2_654_435_761) % COLLABORATOR_COLOR_SPACE;
  return `#${color.toString(16).padStart(6, "0")}`;
};

/** The inspector docks the editor beside the page; full view owns the page. */
export type DocxEditorSurface = "fullView" | "inspector";

type DocxBrowserEditorBaseProps = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  propertyId: string;
  initialScrollTop?: number | undefined;
  isEditing?: boolean | undefined;
  onClose: () => void;
  onCompatibilityChange?:
    | ((compatibility: DocxCompatibility) => void)
    | undefined;
  onCollaborationPublishableChange?:
    | ((publishable: boolean) => void)
    | undefined;
  canUnlock?: boolean | undefined;
  onBlockedUnlock?: (() => void) | undefined;
  onUnlockedChange?: ((isUnlocked: boolean) => void) | undefined;
  onSaved?: ((fieldId: string) => void) | undefined;
  onReadonlyEditAttempt?: (() => void) | undefined;
  onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  collaboration?: DocxEditorCollaboration | undefined;
  scaleOffset?: number | undefined;
  actionsKey?: string | undefined;
  actionsMapRef?: RefObject<Map<string, DocxBrowserEditorActions>> | undefined;
  actionsRef?: RefObject<DocxBrowserEditorActions | null> | undefined;
  actionBarControls?: ReactNode | undefined;
  showActionBar?: boolean | undefined;
  /** Which chrome hosts the editor; selects the find-bar behavior. */
  surface: DocxEditorSurface;
  errorFallback?: ((props: { reset: () => void }) => ReactNode) | undefined;
  onError?: ((error: Error) => void) | undefined;
};

type PendingCollaborationPublication = {
  downloadUrl: string;
  generation: number;
  idempotencyKey: string;
  roomId: string;
  sha256Hex: string;
};

type DocxBrowserEditorProps = DocxBrowserEditorBaseProps;

export type DocxBrowserEditorActions = {
  cancel: () => Promise<void>;
  finalize: () => void;
  /**
   * Force-checkpoint any pending in-flight edits to the server,
   * bypassing the debounce. Call this before navigating away from
   * the editor (e.g. the sidepeek → full view handoff) so the
   * next mount of the same edit session downloads the user's
   * latest changes instead of an older snapshot. Resolves once
   * the checkpoint round-trip completes; rejects only on
   * unexpected errors (network failures are surfaced through the
   * autosave status).
   */
  flushPendingChanges: () => Promise<void>;
  print: () => void;
  unlock: () => void;
};

export const DocxBrowserEditor = (props: DocxBrowserEditorProps) => {
  const { errorFallback, fieldId, onError, workspaceId } = props;

  return (
    <QuerySuspenseBoundary
      area="docx-browser-editor"
      errorFallback={errorFallback ?? defaultDocxBrowserEditorErrorFallback}
      suspenseFallback={<DocxBrowserEditorPendingFallback {...props} />}
      onError={onError}
      resetKeys={[workspaceId, fieldId]}
    >
      <RenderStormRegion name="docx-browser-editor">
        <DocxBrowserEditorContent {...props} />
      </RenderStormRegion>
    </QuerySuspenseBoundary>
  );
};

const DocxBrowserEditorContent = (props: DocxBrowserEditorProps) => {
  const {
    workspaceId,
    entityId,
    fieldId,
    propertyId,
    actionsKey,
    actionsMapRef,
    actionsRef,
    actionBarControls,
    canUnlock = true,
    collaboration,
    isEditing = true,
    initialScrollTop,
    onClose,
    onCollaborationPublishableChange,
    onCompatibilityChange,
    onBlockedUnlock,
    onUnlockedChange,
    onSaved,
    onReadonlyEditAttempt,
    onScrollTopChange,
    scaleOffset = 0,
    showActionBar = true,
    surface,
  } = props;
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingCollaborationPublicationRef =
    useRef<PendingCollaborationPublication | null>(null);
  const isPublishingCollaborationVersionRef = useRef(false);
  const queryClient = useQueryClient();
  const [
    isPublishingCollaborationVersion,
    setIsPublishingCollaborationVersion,
  ] = useState(false);
  // Track the live ProseMirror view so we can dispatch the
  // workspace anonymization-term list into the decoration plugin
  // installed inside Folio. The view is captured via the
  // onEditorViewReady callback below; the effect re-pushes the
  // term list whenever it (or the view) changes.
  const [editorViewForAnonymization, setEditorViewForAnonymization] =
    useState<EditorView | null>(null);

  // Inline autocomplete (ghost-text + "stella" caret). Behind a
  // dev gate while the feature is shaking out; promotes to a real
  // toggle once retrieval grounding is wired and the audit-log
  // table exists. The hook installs a transaction wrapper on the
  // view and tears down on unmount.
  useAutocompleteStream(editorViewForAnonymization, {
    enabled: import.meta.env.DEV,
    language: "en",
  });
  // True while the inspector's Anonymization facet is mounted.
  // We gate both the term feed *and* the detection heartbeat on
  // this so highlights paint only while the user is on that tab
  // — switching to Metadata / History / Suggestions clears the
  // overlay immediately and stops the wasm pipeline from running
  // in the background.
  const isAnonymizationActive = useIsAnonymizationActive();
  const anonymizationTermsQuery = useQuery(
    anonymizationTermsOptions(workspaceId),
  );
  const workspaceAnonymizationTerms = useMemo<AnonymizationTerm[]>(() => {
    if (!anonymizationTermsQuery.data) {
      return [];
    }
    return anonymizationTermsQuery.data.entries.map((entry) => ({
      canonical: entry.canonical,
      label: entry.label,
      variants: entry.variants,
    }));
  }, [anonymizationTermsQuery.data]);
  // Detected-entity highlights — runs the wasm anonymization
  // pipeline against the live doc text and exposes each detected
  // entity as a Folio decoration term. Combined with workspace
  // vocabulary so the editor shows everything that *would* be
  // anonymized right now, not only the curated catalogue.
  //
  // Re-runs when the doc text changes (debounced inside the
  // effect) so edits and reloads pick up new entities without
  // re-running on every keystroke.
  const [detectedAnonymizationTerms, setDetectedAnonymizationTerms] = useState<
    AnonymizationTerm[]
  >([]);
  // Exposed by the detection heartbeat effect below so the
  // exclusions-watching effect can kick a fresh run the moment
  // the allowlist changes, instead of waiting for the next 2s
  // heartbeat tick.
  const runDetectionRef = useRef<(() => void) | null>(null);
  useExternalSyncEffect(() => {
    const view = editorViewForAnonymization;
    if (!view || !isAnonymizationActive) {
      // Facet not on screen: skip the wasm pipeline entirely and
      // drop any previously detected terms so a re-mount starts
      // from a clean slate.
      setDetectedAnonymizationTerms([]);
      return undefined;
    }
    let cancelled = false;
    // Mark the pipeline as in-flight from mount so the
    // inspector facet shows "Detecting entities…" right
    // away instead of flashing "0 entities" during the
    // 300ms gap before the first `run()` fires (and
    // before that run can call `markAnonymizationPipelineStarted`
    // itself). The first `run()` also calls it again
    // (idempotent set-add); subsequent runs flip it on
    // around each worker call.
    useInspectorAnonymizationStore
      .getState()
      .markAnonymizationPipelineStarted(fieldId);
    // Track the text+exclusions we received *results* for (not
    // just dispatched). The worker can occasionally drop a
    // request across dev HMR (the singleton's pending map loses
    // entries when the client module re-evaluates); the next tick
    // simply re-dispatches until results actually land.
    //
    // Exclusions are part of the cache key: when the user marks
    // a detected entity as a false positive, the doc text is
    // unchanged but the worker needs to rerun with the new
    // allowlist so the now-excluded canonical disappears from
    // detected terms without waiting for the user to edit.
    let lastDeliveredKey: string | null = null;
    // Suppress overlapping calls for a short window so we don't
    // queue up dozens of requests for a stable doc; if the call
    // never delivers, the window expires and a retry fires.
    let inFlightUntil = 0;
    const IN_FLIGHT_TIMEOUT_MS = 10_000;
    const markRan = () =>
      useInspectorAnonymizationStore
        .getState()
        .markAnonymizationPipelineRan(fieldId);
    const run = () => {
      if (cancelled) {
        return;
      }
      // Cheap in-flight short-circuit before serializing the doc:
      // `view.state.doc.textContent` walks the whole ProseMirror
      // tree, so on large DOCX files we must not pay it every 2s
      // tick while a worker request is still pending. The decision
      // helper repeats this guard for its own correctness, but the
      // expensive read has to stay behind it.
      const now = Date.now();
      if (now < inFlightUntil) {
        return;
      }
      const text = view.state.doc.textContent;
      const excluded = excludedCanonicalsRef.current;
      const cacheKey = buildAnonymizationDetectionKey({
        text,
        excludedCanonicals: excluded,
      });
      const decision = decideAnonymizationDetectionRun({
        text,
        cacheKey,
        lastDeliveredKey,
        inFlightUntil,
        now,
      });
      if (decision.action === "skip") {
        return;
      }
      if (decision.action === "markRan") {
        // Empty doc: nothing to detect. Release the
        // "in flight" lock so the facet exits the
        // "Detecting…" placeholder instead of stalling
        // on the mount-time mark.
        markRan();
        return;
      }
      if (decision.action === "alreadyDelivered") {
        // Already delivered for this exact text +
        // exclusions; no-op without flipping the
        // started state (we're not running anything).
        return;
      }
      inFlightUntil = Date.now() + IN_FLIGHT_TIMEOUT_MS;
      // (Re-)mark started: handles reruns triggered by
      // edits or allowlist changes after the first run
      // already called `markAnonymizationPipelineRan`.
      useInspectorAnonymizationStore
        .getState()
        .markAnonymizationPipelineStarted(fieldId);
      anonymizeChatTextInWorker({
        text,
        workspaceId,
        excludedCanonicals: excluded,
      })
        .then((result) => {
          inFlightUntil = 0;
          if (cancelled) {
            return;
          }
          lastDeliveredKey = cacheKey;
          setDetectedAnonymizationTerms(
            dedupeDetectedAnonymizationTerms(result.pairs),
          );
          markRan();
          return;
        })
        .catch((error: unknown) => {
          inFlightUntil = 0;
          // Surface worker failures to telemetry: a silent reset
          // hides systemic detection-worker breakage behind a facet
          // that merely stops showing "Detecting…".
          getAnalytics().captureError(error);
          // Mark on failure too — without this, a worker
          // error would leave the facet stuck on
          // "Detecting…" forever.
          markRan();
        });
    };
    // The doc text isn't always populated when the view first
    // captures (lazy DOCX load, async paged rendering). Slow
    // heartbeat catches it shortly after, and also picks up
    // edits without per-keystroke pipeline runs. The same-text
    // guard above no-ops re-runs once the doc is steady.
    const initialTimer = setTimeout(run, 300);
    const heartbeat = setInterval(run, 2000);
    // Expose `run` so an outside effect can kick a fresh
    // detection right after the user toggles an exclusion,
    // without waiting up to a heartbeat tick for the new
    // allowlist to take effect.
    runDetectionRef.current = run;
    return () => {
      cancelled = true;
      runDetectionRef.current = null;
      clearTimeout(initialTimer);
      clearInterval(heartbeat);
      // Release the in-flight lock on unmount/dep change
      // so a stale "Detecting…" doesn't survive a tab
      // switch or an anonymization toggle-off.
      markRan();
    };
  }, [editorViewForAnonymization, isAnonymizationActive, workspaceId, fieldId]);
  // Per-doc allowlist: canonicals the user has flagged as false
  // positives. The chat-anon worker filters these out of its
  // detected entities itself; we still need to strip them from
  // the workspace catalog list, because catalog terms are sent
  // straight to Folio without going through the worker.
  const allowlistQuery = useQuery({
    ...anonymizationAllowlistOptions({ workspaceId, entityId }),
    enabled: isAnonymizationActive,
  });
  const excludedCanonicalsSet = useMemo(
    () =>
      buildExcludedCanonicalsSet(
        allowlistQuery.data ? allowlistQuery.data.entries : [],
      ),
    [allowlistQuery.data],
  );
  // Hold the latest list in a ref so the chat-anon polling effect
  // sees fresh exclusions without re-installing its heartbeat on
  // every keystroke / mutation.
  const excludedCanonicalsRef = useRef<readonly string[]>([]);
  useExternalSyncEffect(() => {
    // eslint-disable-next-line react/react-compiler -- latest-ref mirror consumed by the polling effect, never rendered
    excludedCanonicalsRef.current = [...excludedCanonicalsSet];
    // Kick the detection right away so worker-found terms that
    // the user just added to the allowlist disappear without
    // having to wait up to 2s for the next heartbeat tick.
    runDetectionRef.current?.();
  }, [excludedCanonicalsSet]);
  const mergedAnonymizationTerms = useMemo<AnonymizationTerm[]>(
    () =>
      mergeAnonymizationTerms({
        isAnonymizationActive,
        workspaceTerms: workspaceAnonymizationTerms,
        detectedTerms: detectedAnonymizationTerms,
        excludedCanonicals: excludedCanonicalsSet,
      }),
    [
      isAnonymizationActive,
      workspaceAnonymizationTerms,
      detectedAnonymizationTerms,
      excludedCanonicalsSet,
    ],
  );
  // Dispatch the live term list into the plugin. We can't simply
  // read matches right after `dispatch` because DOCX content
  // loads asynchronously: the first dispatch hits an empty doc
  // (matches=[]), then PM's docChanged transaction rebuilds
  // matches *later* without our effect re-firing. Publishing is
  // handled by the polling effect below.
  useExternalSyncEffect(() => {
    const view = editorViewForAnonymization;
    if (!view) {
      return;
    }
    try {
      const { key, payload } = setAnonymizationTermsMeta(
        mergedAnonymizationTerms,
      );
      view.dispatch(view.state.tr.setMeta(key, payload));
    } catch {
      // wait for the next onEditorViewReady capture to retry.
    }
  }, [editorViewForAnonymization, mergedAnonymizationTerms]);
  // Publish the plugin's live match list to the inspector facet
  // so it can show counts and filter the workspace vocabulary
  // list. Polls once a second — cheap, and necessary because the
  // plugin rebuilds matches on async doc loads / edits that our
  // React effect deps cannot observe directly. Skipped state
  // updates are no-ops (zustand suppresses sets that yield
  // identical references); the entry is cleared on unmount.
  // Wired from the plugin via Folio's
  // `onAnonymizationMatchesChange` prop below. The plugin emits
  // the current match list on every transition (init, term push,
  // doc edit, async DOCX load); we mirror it into the matches
  // store so the inspector facet's counter and "matching
  // workspace terms" list stay in sync.
  const handleAnonymizationMatchesChange = useCallback(
    (matches: readonly { canonical: string; label: string }[]) => {
      const { publishAnonymizationMatches } =
        useInspectorAnonymizationStore.getState();
      if (!isAnonymizationActive) {
        return;
      }
      publishAnonymizationMatches(
        fieldId,
        aggregateAnonymizationMatches(matches),
      );
    },
    [fieldId, isAnonymizationActive],
  );
  useExternalSyncEffect(() => {
    const { clearAnonymizationMatches } =
      useInspectorAnonymizationStore.getState();
    if (!isAnonymizationActive) {
      clearAnonymizationMatches(fieldId);
    }
    return () => {
      clearAnonymizationMatches(fieldId);
    };
  }, [fieldId, isAnonymizationActive]);

  // Bridge document selections → inspector "Term to anonymize"
  // input. Folio fires `onSelectionTextChange` with the range
  // and the resolved text on every selection-bearing
  // transaction, so we just have to length-gate and publish.
  // The cleanup clears the store so a second tab opening this
  // facet doesn't see a stale prefill from the previous file.
  const handleSelectionTextChange = useCallback(
    (selection: { from: number; to: number; text: string }) => {
      if (selection.from === selection.to) {
        return;
      }
      const single = selection.text.replace(/\s+/gu, " ").trim();
      if (single.length < 2 || single.length > 200) {
        return;
      }
      useInspectorAnonymizationStore
        .getState()
        .publishDocumentTextSelection(fieldId, single);
    },
    [fieldId],
  );
  useExternalSyncEffect(
    () => () => {
      useInspectorAnonymizationStore
        .getState()
        .clearDocumentTextSelection(fieldId);
    },
    [fieldId],
  );

  // Two-way bridge with the inspector anonymization facet.
  // - Click in document → push to store as source="doc" with
  //   this editor's fieldId so only this document's facet
  //   reacts.
  // - Selection from sidebar (source="sidebar") → forward
  //   canonical + seq to Folio only when the bridged fieldId
  //   matches. Background editor panes (cached inactive tabs)
  //   stay quiet.
  // - Doc-sourced selections aren't echoed back to the editor —
  //   that would re-scroll on its own click.
  const handleAnonymizationTermClick = useCallback(
    (canonical: string, label: string) => {
      useInspectorAnonymizationStore
        .getState()
        .selectAnonymizationTerm(canonical, label, "doc", fieldId);
    },
    [fieldId],
  );
  const sidebarSelectedCanonical = useInspectorAnonymizationStore((s) =>
    s.anonymizationSelection.source === "sidebar" &&
    s.anonymizationSelection.fieldId === fieldId
      ? s.anonymizationSelection.canonical
      : null,
  );
  const sidebarSelectionSeq = useInspectorAnonymizationStore((s) =>
    s.anonymizationSelection.source === "sidebar" &&
    s.anonymizationSelection.fieldId === fieldId
      ? s.anonymizationSelection.seq
      : 0,
  );
  const didOpenRef = useRef(false);
  const pendingEditRequestRef = useRef(false);
  const errorToastShownRef = useRef(false);
  const lastStyleLabelRef = useRef("Normal");
  const lastStyleLabelStyleRef = useRef<CSSProperties | undefined>(undefined);
  const optimisticPreviewRef = useRef<OptimisticPreviewFile | null>(null);
  const finalizedBufferRef = useRef<ArrayBuffer | null>(null);
  const lastEditingBufferRef = useRef<ArrayBuffer | null>(null);
  const hasSessionChangesRef = useRef(false);
  const preservedLoadedBufferRef = useRef<{
    buffer: ArrayBuffer;
    fieldId: string;
  } | null>(null);
  const changeCheckpointTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const changeCheckpointIdleCallbackRef = useRef<number | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("editing");
  const editTargetKey = `${workspaceId}:${entityId}:${propertyId}:${fieldId}`;
  const [compatibilityState, setCompatibilityState] = useState<{
    targetKey: string;
    value: DocxCompatibility | null;
  }>({ targetKey: editTargetKey, value: null });
  const compatibility =
    compatibilityState.targetKey === editTargetKey
      ? compatibilityState.value
      : null;
  const [autosaveStatus, setAutosaveStatus] =
    useState<AutosaveStatus>("synced");
  // Controlled `DocxEditor` comment state, round-tripped back through
  // `onCommentsChange`. Feeds the file-chat overlay's folio-agents comment
  // tools (read/add/reply/resolve) via `FileViewerWithAI`, and lets those
  // mutations (reply / resolve) flow back into the editor. Reset when the
  // loaded document changes (see `docxCommentsDocId` below) so a new file
  // never briefly renders the previous file's comments.
  const [docxComments, setDocxComments] = useState<DocxComments>([]);
  const [docxCommentsDocId, setDocxCommentsDocId] = useState<string | null>(
    null,
  );
  const [
    pendingInitialDocxCommentsSyncDocId,
    setPendingInitialDocxCommentsSyncDocId,
  ] = useState<string | null>(null);
  const { containerRef: fitZoomRef, fitZoom: targetZoom } = useDocxFitZoom({
    scaleOffset,
    maxAutoZoom: 0.85,
  });
  // Stable ref callback so React doesn't detach/re-attach the fit-zoom
  // ResizeObserver every render.
  const composedContainerRef = useMemo(
    () => composeRefs(containerRef, fitZoomRef),
    [fitZoomRef],
  );
  // Full view leaves Cmd+F to Folio's own dialog, which has the whole
  // viewport to sit in; only the docked inspector needs its own bar.
  const find = useDocxFind({
    containerRef,
    editorRef,
    enabled: surface === "inspector",
  });
  const t = useTranslations();
  const format = useFormatter();
  /* eslint-disable react/react-compiler -- optimistic preview and its derived query data are deliberately carried across the finalize/refetch window in a mutable ref */
  const optimisticPreview = optimisticPreviewRef.current;
  const previewPlaceholderData =
    optimisticPreview?.fieldId === fieldId
      ? optimisticPreview.file
      : keepPreviousData;
  const previewFileQuery = useQuery({
    ...fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
    placeholderData: previewPlaceholderData,
  });
  const canAutoRequestCollaboration =
    isEditing &&
    !previewFileQuery.isPlaceholderData &&
    compatibility?.canSafelyEdit === true;
  const collaborationRuntime = useDocxBrowserCollaboration({
    canUnlock,
    externalCollaboration: collaboration,
    entityId,
    propertyId,
    initiallyRequested: canAutoRequestCollaboration,
    workspaceId,
  });
  const {
    activeCollaboration,
    cancelCollaboration,
    collaborationEnabled,
    collaborationSession,
    collaborationState,
    canEditCollaboratively,
    isCollaborativeEditing,
    requestCollaboration,
  } = collaborationRuntime;
  const canPublishCollaborationVersion =
    collaborationState.status === "synced" && !isPublishingCollaborationVersion;

  useExternalSyncEffect(() => {
    onCollaborationPublishableChange?.(canPublishCollaborationVersion);
    return () => onCollaborationPublishableChange?.(false);
  }, [canPublishCollaborationVersion, onCollaborationPublishableChange]);

  if (previewFileQuery.error) {
    throw previewFileQuery.error;
  }

  const previewFile = previewFileQuery.data
    ? selectPreviewFile({
        file: previewFileQuery.data,
        optimisticPreview,
        fieldId,
      })
    : null;
  /* eslint-enable react/react-compiler */
  const {
    state,
    isDirty,
    open,
    markDirty,
    saveCheckpoint: saveDesktopCheckpoint,
    finalize: finalizeDesktopSession,
    cancel: cancelDesktopSession,
    resetError,
  } = useEditSession({
    workspaceId,
    entityId,
    fieldId,
    propertyId,
    initialBuffer: previewFile?.buffer,
    onFinalized: (result) => {
      if (result.outcome === "finalized") {
        const finalizedBuffer = finalizedBufferRef.current;
        if (finalizedBuffer !== null && previewFile !== null) {
          optimisticPreviewRef.current = {
            fieldId: result.fieldId,
            file: {
              ...previewFile,
              buffer: finalizedBuffer,
            },
          };
        }
        const preservedLoadedBuffer = preservedLoadedBufferRef.current;
        if (preservedLoadedBuffer !== null) {
          preservedLoadedBufferRef.current = {
            ...preservedLoadedBuffer,
            fieldId: result.fieldId,
          };
        }
        onSaved?.(result.fieldId);
      }
      finalizedBufferRef.current = null;
      onClose();
    },
    onCancelled: onClose,
  });

  const saveActiveCheckpoint = saveDesktopCheckpoint;
  const finalizeActiveSession = finalizeDesktopSession;
  const cancelActiveSession = useCallback(async () => {
    if (collaborationSession !== null) {
      cancelCollaboration();
      onClose();
      return;
    }

    await cancelDesktopSession();
  }, [
    cancelCollaboration,
    cancelDesktopSession,
    collaborationSession,
    onClose,
  ]);

  useExternalSyncEffect(() => {
    if (optimisticPreviewRef.current?.fieldId === fieldId) {
      return;
    }
    optimisticPreviewRef.current = null;
    finalizedBufferRef.current = null;
    lastEditingBufferRef.current = null;
    hasSessionChangesRef.current = false;
    pendingCollaborationPublicationRef.current = null;
    preservedLoadedBufferRef.current = null;
    pendingEditRequestRef.current = false;
    setCompatibilityState({ targetKey: editTargetKey, value: null });
  }, [editTargetKey, fieldId]);

  const abandonUnsafeEditAttempt = useCallback(() => {
    // Editing is blocked because Folio can't safely rewrite this DOCX. The
    // block is surfaced quietly on the composer's edit-mode control (a "View
    // only" chip, driven by `docxEditSafety` below) instead of a disruptive
    // toast on every attempt; just abandon the attempt and stay in view mode.
    onClose();
  }, [onClose]);

  const requestEditMode = useCallback(async () => {
    if (isCollaborativeEditing) {
      return true;
    }

    if (state.status === "editing") {
      return true;
    }

    const blockReason = getDocxEditBlockReason({
      canSafelyEdit: compatibility?.canSafelyEdit,
    });
    if (blockReason === "pendingCompatibility") {
      // Don't bother the user with a "still verifying…" toast just
      // because they clicked the doc while the safety probe is in
      // flight. Queue the request via the inspector's pending-edit
      // slot; `use-docx-tab-edit-session` re-runs once
      // `canSafelyEdit` resolves and silently enters edit mode then.
      pendingEditRequestRef.current = true;
      useInspectorCommandStore.getState().requestDocxEdit(fieldId);
      return false;
    }

    if (blockReason === "unsafe") {
      abandonUnsafeEditAttempt();
      return false;
    }

    if (previewFile === null || state.status !== "idle" || didOpenRef.current) {
      return false;
    }

    if (collaborationEnabled) {
      requestCollaboration();
      return false;
    }

    didOpenRef.current = true;
    errorToastShownRef.current = false;
    const opened = await open();
    if (!opened) {
      didOpenRef.current = false;
    }

    return opened;
  }, [
    compatibility?.canSafelyEdit,
    collaborationEnabled,
    fieldId,
    isCollaborativeEditing,
    open,
    previewFile,
    requestCollaboration,
    abandonUnsafeEditAttempt,
    state.status,
  ]);

  useExternalSyncEffect(() => {
    if (!pendingEditRequestRef.current) {
      return;
    }
    if (
      compatibility === null ||
      previewFile === null ||
      state.status !== "idle"
    ) {
      return;
    }

    pendingEditRequestRef.current = false;
    detached(requestEditMode(), "docx-browser-editor.request-edit-mode");
  }, [compatibility, previewFile, requestEditMode, state.status]);

  // Auto-open when this component is used as a direct editor, or when the
  // preview is explicitly unlocked from the shell toolbar.
  useExternalSyncEffect(() => {
    if (!isEditing || previewFile === null || didOpenRef.current) {
      return;
    }
    if (compatibility === null || state.status !== "idle") {
      return;
    }
    if (
      getDocxEditBlockReason({ canSafelyEdit: compatibility.canSafelyEdit }) ===
      "unsafe"
    ) {
      abandonUnsafeEditAttempt();
      return;
    }
    if (collaborationEnabled) {
      return;
    }
    didOpenRef.current = true;
    errorToastShownRef.current = false;
    detached(open(), "docx-browser-editor.open");
  }, [
    compatibility,
    collaborationEnabled,
    isEditing,
    open,
    previewFile,
    abandonUnsafeEditAttempt,
    state.status,
  ]);

  useExternalSyncEffect(() => {
    if (!isEditing) {
      didOpenRef.current = false;
    }
  }, [isEditing]);

  useLayoutEffect(() => {
    editorRef.current?.setZoom(targetZoom);
  }, [targetZoom]);
  useDocxWheelZoom(containerRef, editorRef);
  useDocxBlockScroll({ editorRef, fieldId });
  // Hydrate persisted AI suggestions into the review store on reload.
  // Lives here (not on the route) because rebuilding each suggestion's
  // preview needs this editor's live snapshot; the review panel/bar
  // then render exactly as they did before the reload.
  useSyncDocxSuggestions({ workspaceId, entityId, editorRef });

  useExternalSyncEffect(() => {
    if (
      state.status !== "error" ||
      (state.source !== "open" && state.source !== "download") ||
      errorToastShownRef.current
    ) {
      return;
    }

    errorToastShownRef.current = true;
    stellaToast.add({
      description: t(editSessionErrorDescriptionKey(state.reason)),
      title: t("folio.editOpenFailedTitle"),
      type: "error",
    });
    onClose();
    resetError();
  }, [onClose, resetError, state, t]);

  const isUnlocked = canEditCollaboratively || state.status === "editing";
  const wasUnlockedRef = useRef(false);

  useExternalSyncEffect(() => {
    onUnlockedChange?.(isUnlocked);
  }, [isUnlocked, onUnlockedChange]);

  // Publish the editor handles to the active-DOCX registry so the
  // inspector's Suggestions facet can apply AI edits without
  // needing to reach into this component's tree. Capture the token
  // returned by `registerEditor` and pass it back to
  // `unregisterEditor` so a fast remount overlap (instance A
  // unmounts AFTER instance B has already registered) doesn't
  // delete B's slot.
  const tokenRef = useRef<ActiveDocxRegistrationToken | null>(null);
  // `isUnlocked` is intentionally NOT in deps: this effect owns the
  // register/unregister lifecycle, and the next sync below propagates
  // lock-state changes via `updateEditable`. Including it here would
  // tear down + re-create the registration on every toggle,
  // invalidating the token contract documented above.
  const registerActiveEditor = useLatestCallback(() => {
    const token = useActiveDocxStore
      .getState()
      .registerEditor(entityId, fieldId, {
        editorRef,
        requestEditMode,
        editable: isUnlocked,
      });
    tokenRef.current = token;
    return () => {
      useActiveDocxStore.getState().unregisterEditor(entityId, fieldId, token);
      if (tokenRef.current === token) {
        tokenRef.current = null;
      }
    };
  });
  useExternalSyncEffect(registerActiveEditor, [
    entityId,
    fieldId,
    requestEditMode,
    registerActiveEditor,
  ]);

  useExternalSyncEffect(() => {
    const token = tokenRef.current;
    if (token === null) {
      return;
    }
    useActiveDocxStore
      .getState()
      .updateEditable(entityId, fieldId, isUnlocked, token);
  }, [entityId, fieldId, isUnlocked]);

  useExternalSyncEffect(() => {
    if (!isUnlocked) {
      wasUnlockedRef.current = false;
      setAutosaveStatus("synced");
      return undefined;
    }

    if (wasUnlockedRef.current) {
      return undefined;
    }

    wasUnlockedRef.current = true;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [isUnlocked]);

  const clearQueuedChangeCheckpoint = useCallback(() => {
    if (changeCheckpointTimerRef.current !== null) {
      clearTimeout(changeCheckpointTimerRef.current);
      changeCheckpointTimerRef.current = null;
    }
    if (changeCheckpointIdleCallbackRef.current !== null) {
      window.cancelIdleCallback(changeCheckpointIdleCallbackRef.current);
      changeCheckpointIdleCallbackRef.current = null;
    }
  }, []);

  // The debounced autosave, the awaitable flush, and the Cmd/Ctrl+S
  // handler all serialize the live editor and persist the buffer.
  // Firing two concurrently raced two `ref.save()` round-trips whose
  // `setAutosaveStatus` writes landed in nondeterministic order (and
  // `flushPendingChanges` cancelled only the queued timer, not an
  // in-flight save). Route every path through one single-flight
  // coordinator: concurrent triggers coalesce into one in-flight
  // save plus one trailing save. `ref.save()` re-snapshots the live
  // document when it runs, so the trailing save captures edits made
  // during the in-flight save (latest wins).
  const runCheckpointSave = useLatestCallback(async () => {
    if (isCollaborativeEditing) {
      // The Hocuspocus provider streams Yjs updates; materializing DOCX in the
      // browser is no longer part of the collaboration persistence path.
      return;
    }

    const ref = editorRef.current;
    if (!ref) {
      return;
    }
    setAutosaveStatus("syncing");
    const buffer = await ref.save({ selective: true });
    const checkpointSaved = buffer ? await saveActiveCheckpoint(buffer) : false;
    setAutosaveStatus(
      resolveCheckpointAutosaveStatus({
        buffer: buffer ?? null,
        checkpointSaved,
      }),
    );
  });

  const reportCheckpointSaveError = useLatestCallback((error: unknown) => {
    getAnalytics().captureError(error);
    setAutosaveStatus("pending");
  });

  // Lazy-init once (React's sanctioned ref pattern): the coordinator
  // owns the in-flight/trailing state, which must survive rerenders.
  // Its `run`/`onError` are stable and read the latest committed
  // closures, so recreating it would only lose that state.
  const triggerCheckpointSaveRef = useRef<(() => Promise<void>) | null>(null);
  triggerCheckpointSaveRef.current ??= createTrailingSingleFlight({
    run: runCheckpointSave,
    onError: reportCheckpointSaveError,
  });
  const triggerCheckpointSave = useCallback(
    async () =>
      await (triggerCheckpointSaveRef.current?.() ?? Promise.resolve()),
    [],
  );

  const saveChangeCheckpoint = useCallback(() => {
    detached(
      triggerCheckpointSave(),
      "docx-browser-editor.trigger-checkpoint-save",
    );
  }, [triggerCheckpointSave]);

  // Awaitable variant of `saveChangeCheckpoint` for callers that
  // need to wait for the round-trip before navigating (e.g. the
  // sidepeek → full view handoff). Cancels the queued debounced
  // checkpoint so we don't fire it twice; the coordinator coalesces
  // an already in-flight save into the trailing run this awaits.
  const flushPendingChanges = useCallback(async () => {
    clearQueuedChangeCheckpoint();
    await triggerCheckpointSave();
  }, [clearQueuedChangeCheckpoint, triggerCheckpointSave]);

  // Cmd+S / Ctrl+S checkpoints only while the document is actively editable.
  useExternalSyncEffect(() => {
    if (!isUnlocked) {
      return undefined;
    }

    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "s") {
        return;
      }

      e.preventDefault();
      clearQueuedChangeCheckpoint();
      detached(
        triggerCheckpointSave(),
        "docx-browser-editor.trigger-checkpoint-save",
      );
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [clearQueuedChangeCheckpoint, isUnlocked, triggerCheckpointSave]);

  useMountEffect(() => () => {
    clearQueuedChangeCheckpoint();
  });

  const scheduleChangeCheckpointSave = useCallback(() => {
    changeCheckpointTimerRef.current = setTimeout(() => {
      changeCheckpointTimerRef.current = null;
      changeCheckpointIdleCallbackRef.current = window.requestIdleCallback(
        () => {
          changeCheckpointIdleCallbackRef.current = null;
          saveChangeCheckpoint();
        },
        { timeout: 2000 },
      );
    }, CHANGE_CHECKPOINT_DELAY);
  }, [saveChangeCheckpoint]);

  const handleChange = useCallback(() => {
    if (!isUnlocked) {
      return;
    }

    hasSessionChangesRef.current = true;
    markDirty();
    clearQueuedChangeCheckpoint();
    if (isCollaborativeEditing) {
      setAutosaveStatus("pending");
      return;
    }

    setAutosaveStatus("pending");
    scheduleChangeCheckpointSave();
  }, [
    clearQueuedChangeCheckpoint,
    isCollaborativeEditing,
    isUnlocked,
    markDirty,
    scheduleChangeCheckpointSave,
    setAutosaveStatus,
  ]);

  // Folio may publish controlled comments after reparsing the same semantic
  // list. Stable callbacks plus equivalent-write suppression prevent a child
  // notification from becoming a parent/child render feedback loop.
  const handleAiDocxCommentsChange = useLatestCallback(
    (comments: DocxComments) => {
      const commentsChanged =
        JSON.stringify(docxComments) !== JSON.stringify(comments);
      setPendingInitialDocxCommentsSyncDocId(null);
      if (!commentsChanged) {
        return;
      }

      setDocxComments(comments);
      handleChange();
    },
  );

  const handleEditorDocxCommentsChange = useLatestCallback(
    (comments: DocxComments) => {
      const isInitialEditorSync = pendingInitialDocxCommentsSyncDocId !== null;
      const commentsChanged =
        JSON.stringify(docxComments) !== JSON.stringify(comments);
      setPendingInitialDocxCommentsSyncDocId(null);
      if (!commentsChanged) {
        return;
      }

      setDocxComments(comments);
      if (!isInitialEditorSync) {
        handleChange();
      }
    },
  );

  const handleEditorModeChange = useCallback(
    (mode: EditorMode) => {
      if (mode !== "viewing") {
        setEditorMode(mode);
      }
    },
    [setEditorMode],
  );

  const handleCompatibilityChange = useLatestCallback(
    (nextCompatibility: DocxCompatibility) => {
      if (previewFileQuery.isPlaceholderData) {
        return;
      }

      setCompatibilityState({
        targetKey: editTargetKey,
        value: nextCompatibility,
      });
      onCompatibilityChange?.(nextCompatibility);
    },
  );

  const handlePublishCollaborationVersion = useCallback(async () => {
    if (
      collaborationSession === null ||
      collaborationState.status !== "synced" ||
      isPublishingCollaborationVersion ||
      isPublishingCollaborationVersionRef.current
    ) {
      return;
    }

    isPublishingCollaborationVersionRef.current = true;
    setIsPublishingCollaborationVersion(true);
    const finishPublishing = () => {
      isPublishingCollaborationVersionRef.current = false;
      setIsPublishingCollaborationVersion(false);
    };
    let pendingPublication = pendingCollaborationPublicationRef.current;
    if (pendingPublication === null) {
      const flushResult = await Result.tryPromise(
        async () => await collaborationSession.flushSnapshot(),
      );
      if (Result.isError(flushResult)) {
        getAnalytics().captureError(flushResult.error);
        finishPublishing();
        stellaToast.add({
          description: t("folio.createVersionFailedDescription"),
          title: t("folio.createVersionFailedTitle"),
          type: "error",
        });
        return;
      }
      const checkpointResult = await Result.tryPromise(async () =>
        api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          ["folio-collab-rooms"].checkpoint.post({
            expectedGeneration: collaborationSession.generation,
            roomId: toSafeId<"folioCollabRoom">(collaborationSession.roomId),
          }),
      );
      if (Result.isError(checkpointResult)) {
        getAnalytics().captureError(checkpointResult.error);
        finishPublishing();
        stellaToast.add({
          description: t("folio.createVersionFailedDescription"),
          title: t("folio.createVersionFailedTitle"),
          type: "error",
        });
        return;
      }
      if (checkpointResult.value.error) {
        getAnalytics().captureError(toAPIError(checkpointResult.value.error));
        finishPublishing();
        stellaToast.add({
          description: t("folio.createVersionFailedDescription"),
          title: t("folio.createVersionFailedTitle"),
          type: "error",
        });
        return;
      }

      const checkpoint = checkpointResult.value.data;
      pendingPublication = {
        downloadUrl: checkpoint.downloadUrl,
        generation: checkpoint.generation,
        idempotencyKey: crypto.randomUUID(),
        roomId: collaborationSession.roomId,
        sha256Hex: checkpoint.sha256Hex,
      };
      pendingCollaborationPublicationRef.current = pendingPublication;
    }
    const publishResult = await Result.tryPromise(async () =>
      api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["folio-collab-rooms"]["publish-version"].post({
          expectedGeneration: pendingPublication.generation,
          expectedSha256Hex: pendingPublication.sha256Hex,
          idempotencyKey: pendingPublication.idempotencyKey,
          roomId: toSafeId<"folioCollabRoom">(pendingPublication.roomId),
        }),
    );
    finishPublishing();
    if (Result.isError(publishResult)) {
      getAnalytics().captureError(publishResult.error);
      stellaToast.add({
        description: t("folio.createVersionFailedDescription"),
        title: t("folio.createVersionFailedTitle"),
        type: "error",
      });
      return;
    }
    if (publishResult.value.error) {
      const apiError = toAPIError(publishResult.value.error);
      getAnalytics().captureError(apiError);
      if (apiError.code === "folio_collab_base_version_changed") {
        pendingCollaborationPublicationRef.current = null;
        stellaToast.add({
          action: {
            label: t("folio.downloadCheckpoint"),
            onClick: () => {
              openIsolatedWindow(pendingPublication.downloadUrl);
            },
          },
          description: t("folio.versionConflictDescription"),
          title: t("folio.versionConflictTitle"),
          type: "warning",
        });
        return;
      }
      if (
        apiError.code === "folio_collab_checkpoint_changed" ||
        apiError.code === "folio_collab_idempotency_key_reused"
      ) {
        pendingCollaborationPublicationRef.current = null;
      }
      stellaToast.add({
        description: t("folio.createVersionFailedDescription"),
        title: t("folio.createVersionFailedTitle"),
        type: "error",
      });
      return;
    }

    pendingCollaborationPublicationRef.current = null;
    hasSessionChangesRef.current = false;
    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
    stellaToast.add({
      description: t("folio.versionCreatedDescription", {
        versionNumber: format.number(publishResult.value.data.versionNumber),
      }),
      title: t("folio.versionCreatedTitle"),
      type: "success",
    });
  }, [
    collaborationSession,
    collaborationState.status,
    format,
    isPublishingCollaborationVersion,
    queryClient,
    t,
    workspaceId,
  ]);

  const handleFinalize = useCallback(async () => {
    // Soft, non-blocking reminder: if AI suggestions are still pending
    // for this entity, note it once before finalizing. Purely
    // informational — finalize proceeds either way (the suggestions
    // persist and can be reviewed after).
    const pendingSuggestionCount =
      useReviewStore
        .getState()
        .sessions[entityId]?.filter((s) => s.status === "pending").length ?? 0;
    if (pendingSuggestionCount > 0) {
      stellaToast.info(
        t("docxReview.finalizePendingNote", {
          count: pendingSuggestionCount,
        }),
      );
    }

    if (isCollaborativeEditing) {
      clearQueuedChangeCheckpoint();
      await handlePublishCollaborationVersion();
      return;
    }

    // Save the final version before finalizing
    clearQueuedChangeCheckpoint();

    const ref = editorRef.current;
    if (!ref) {
      stellaToast.add({
        description: t("folio.saveEditorUnavailableDescription"),
        title: t("folio.saveEditorUnavailableTitle"),
        type: "error",
      });
      return;
    }

    const hasPendingEditorChanges = ref.hasPendingChanges();
    if (
      !shouldFinalizeEditSession({
        isDirty,
        hasSessionChanges: hasSessionChangesRef.current,
        hasPendingEditorChanges,
      })
    ) {
      await cancelActiveSession();
      return;
    }

    const buffer = await ref.save({ selective: true });
    if (!buffer) {
      stellaToast.add({
        description: t("folio.saveSerializeFailedDescription"),
        title: t("folio.saveSerializeFailedTitle"),
        type: "error",
      });
      return;
    }

    setAutosaveStatus("syncing");
    const saved = await saveActiveCheckpoint(buffer);
    if (!saved) {
      setAutosaveStatus("pending");
      stellaToast.add({
        description: t("folio.saveCheckpointFailedDescription"),
        title: t("folio.saveCheckpointFailedTitle"),
        type: "error",
      });
      return;
    }
    setAutosaveStatus("synced");
    if (previewFile !== null) {
      optimisticPreviewRef.current = {
        fieldId,
        file: {
          ...previewFile,
          buffer,
        },
      };
    }
    if (lastEditingBufferRef.current !== null) {
      preservedLoadedBufferRef.current = {
        fieldId,
        buffer: lastEditingBufferRef.current,
      };
    }
    finalizedBufferRef.current = buffer;
    hasSessionChangesRef.current = false;
    await finalizeActiveSession();
  }, [
    cancelActiveSession,
    clearQueuedChangeCheckpoint,
    entityId,
    fieldId,
    finalizeActiveSession,
    isCollaborativeEditing,
    handlePublishCollaborationVersion,
    isDirty,
    optimisticPreviewRef,
    previewFile,
    saveActiveCheckpoint,
    setAutosaveStatus,
    t,
  ]);

  const handleCancel = useCallback(async () => {
    clearQueuedChangeCheckpoint();
    preservedLoadedBufferRef.current = null;
    hasSessionChangesRef.current = false;
    await cancelActiveSession();
  }, [cancelActiveSession, clearQueuedChangeCheckpoint]);

  const handleUnlock = useCallback(() => {
    if (!canUnlock) {
      onBlockedUnlock?.();
      return;
    }

    const blockReason = getDocxEditBlockReason({
      canSafelyEdit: compatibility?.canSafelyEdit,
    });
    if (blockReason === "pendingCompatibility") {
      // Queue silently — see requestEditMode for rationale.
      pendingEditRequestRef.current = true;
      useInspectorCommandStore.getState().requestDocxEdit(fieldId);
      return;
    }

    if (blockReason === "unsafe") {
      abandonUnsafeEditAttempt();
      return;
    }
    if (collaborationEnabled) {
      requestCollaboration();
      return;
    }
    if (
      previewFile !== null &&
      state.status === "idle" &&
      !didOpenRef.current
    ) {
      didOpenRef.current = true;
      errorToastShownRef.current = false;
      detached(open(), "docx-browser-editor.open");
    }
  }, [
    canUnlock,
    compatibility?.canSafelyEdit,
    collaborationEnabled,
    fieldId,
    onBlockedUnlock,
    open,
    previewFile,
    requestCollaboration,
    abandonUnsafeEditAttempt,
    state.status,
  ]);

  const handleLockedEditAttempt = useCallback(() => {
    if (isUnlocked) {
      return;
    }
    onReadonlyEditAttempt?.();
    handleUnlock();
  }, [handleUnlock, isUnlocked, onReadonlyEditAttempt]);

  const handleToggleLock = useCallback(() => {
    if (!isUnlocked) {
      handleUnlock();
      return;
    }
    detached(handleFinalize(), "docx-browser-editor.finalize");
  }, [handleFinalize, handleUnlock, isUnlocked]);

  // Registers this render's action handles into the parent-provided ref
  // and/or keyed map. Wrapped in useCallback (stable unless actionsKey /
  // actionsMapRef / actionsRef change) so useImperativeHandle only
  // re-attaches for those changes or for its own dep list below.
  const registerActions = useCallback(
    (actions: DocxBrowserEditorActions | null) => {
      if (!actions) {
        return undefined;
      }
      const actionsMap = actionsMapRef?.current;
      if (actionsRef) {
        actionsRef.current = actions;
      }
      if (actionsMap && actionsKey) {
        actionsMap.set(actionsKey, actions);
      }

      return () => {
        if (actionsRef?.current === actions) {
          actionsRef.current = null;
        }
        if (
          actionsMap &&
          actionsKey &&
          actionsMap.get(actionsKey) === actions
        ) {
          actionsMap.delete(actionsKey);
        }
      };
    },
    [actionsKey, actionsMapRef, actionsRef],
  );

  useImperativeHandle(
    registerActions,
    () => ({
      cancel: handleCancel,
      finalize: () => {
        if (isCollaborativeEditing || state.status === "editing") {
          detached(handleFinalize(), "docx-browser-editor.finalize");
        }
      },
      flushPendingChanges,
      print: () => {
        editorRef.current?.print();
      },
      unlock: () => {
        detached(requestEditMode(), "docx-browser-editor.request-edit-mode");
      },
    }),
    [
      flushPendingChanges,
      handleCancel,
      handleFinalize,
      isCollaborativeEditing,
      requestEditMode,
      state.status,
    ],
  );

  // Hold the last editing buffer so the editor doesn't swap to the
  // preview buffer during the save transition (`state` becomes
  // "saving" with no buffer of its own). Without this we'd reload the
  // editor against `previewFile.buffer` for the few hundred ms before
  // the parent unmounts us — and the Stella fallback would flash.
  /* eslint-disable react/react-compiler -- editing buffers and the derived editor buffer are intentionally latched in refs across the save transition */
  const editorBuffer = resolveAndPreserveDocxEditorBuffer({
    collaborationSeedBuffer: collaborationSession?.seedDocumentBuffer ?? null,
    fieldId,
    isCollaborativeEditing,
    lastEditingBufferRef,
    preservedLoadedBufferRef,
    previewBuffer: previewFile?.buffer,
    state,
  });
  /* eslint-enable react/react-compiler */
  const finishEditingLabel = t("folio.finishEditing");
  const createVersionLabel = t("folio.createVersion");

  const toolbarExtra = (() => {
    if (showActionBar || actionBarControls !== undefined) {
      return (
        <>
          {actionBarControls}
          {showActionBar && collaborationState.room !== null && (
            <>
              <Button
                className="min-h-11 px-3"
                disabled={!canPublishCollaborationVersion}
                onClick={() => {
                  detached(
                    handlePublishCollaborationVersion(),
                    "docx-browser-editor.publish-collaboration-version",
                  );
                }}
                size="sm"
                tooltip={createVersionLabel}
              >
                <GitCommitHorizontalIcon />
                <span>{createVersionLabel}</span>
              </Button>
              <CollaborationStatusIndicator
                status={collaborationState.status}
              />
              <CollaborationPresence
                awareness={collaborationState.room.collaboration.awareness}
              />
              <Button
                aria-label={t("common.close")}
                className="min-h-11 px-3"
                onClick={() => {
                  detached(handleCancel(), "docx-browser-editor.close");
                }}
                size="sm"
                tooltip={t("common.close")}
                variant="ghost"
              >
                <XIcon />
                <span>{t("common.close")}</span>
              </Button>
            </>
          )}
          {showActionBar && isUnlocked && !isCollaborativeEditing && (
            <>
              <Button
                aria-label={finishEditingLabel}
                className="px-2"
                disabled={
                  state.status === "opening" ||
                  state.status === "saving" ||
                  collaborationState.status === "connecting"
                }
                onClick={handleToggleLock}
                size="sm"
                tooltip={finishEditingLabel}
                variant="ghost"
              >
                <LockOpenIcon />
                <span>{finishEditingLabel}</span>
              </Button>
              <AutosaveIndicator status={autosaveStatus} />
            </>
          )}
        </>
      );
    }
    return undefined;
  })();

  useExternalSyncEffect(() => {
    if (!isUnlocked) {
      setEditorMode("editing");
    }
  }, [isUnlocked]);

  useLayoutEffect(() => {
    const styleLabelElement = containerRef.current?.querySelector<HTMLElement>(
      '.folio-style-picker [data-slot="select-value"]',
    );
    if (!styleLabelElement) {
      return;
    }

    const stylePreviewElement =
      styleLabelElement.querySelector<HTMLElement>("[style]") ??
      styleLabelElement;
    const styleLabelText = Reflect.get(styleLabelElement, "textContent");
    const styleLabel =
      typeof styleLabelText === "string" ? styleLabelText.trim() : "";

    if (styleLabel.length > 0) {
      lastStyleLabelRef.current = styleLabel;
    }

    const computedStyle = window.getComputedStyle(stylePreviewElement);
    lastStyleLabelStyleRef.current = {
      color: computedStyle.color,
      fontSize: computedStyle.fontSize,
      fontStyle: computedStyle.fontStyle,
      fontWeight: computedStyle.fontWeight,
      lineHeight: computedStyle.lineHeight,
    };
  });

  if (
    state.status === "error" &&
    state.source !== "open" &&
    state.source !== "download"
  ) {
    return (
      <StatusMessage
        actionButton={
          <Button onClick={onClose} size="sm" variant="outline">
            {t("common.close")}
          </Button>
        }
        className="h-full w-full"
        description={
          // For known reasons, prefer the localized message — the
          // backend `state.detail` is wire jargon ("Desktop editing
          // moved to another device.") even for in-browser sessions
          // and reads as alarming. Fall back to detail only when the
          // reason is "unknown".
          state.reason === "unknown" && state.detail !== undefined
            ? state.detail
            : t(editSessionErrorDescriptionKey(state.reason))
        }
        status="error"
        title={t("folio.editSaveFailedTitle")}
      />
    );
  }

  if (
    collaborationState.status === "unavailable" &&
    collaborationState.message !== null
  ) {
    return (
      <StatusMessage
        actionButton={
          <Button onClick={onClose} size="sm" variant="outline">
            {t("common.close")}
          </Button>
        }
        className="h-full w-full"
        description={collaborationState.message}
        status="error"
        title={t("folio.editOpenFailedTitle")}
      />
    );
  }

  // eslint-disable-next-line react/react-compiler -- retain the last style label in a ref to avoid a loading-state flash
  const lastStyleLabel = lastStyleLabelRef.current;
  // eslint-disable-next-line react/react-compiler -- retain the matching label style for the same loading-state fallback
  const lastStyleLabelStyle = lastStyleLabelStyleRef.current;

  if (previewFile === null || editorBuffer === undefined) {
    return (
      <DocxEditorLoadingFallback
        label={t("folio.loadingDocument")}
        scaleOffset={scaleOffset}
        showActionBar={showActionBar}
        stylePickerLabel={lastStyleLabel}
        stylePickerLabelStyle={lastStyleLabelStyle}
        toolbarExtra={toolbarExtra}
        zoom={targetZoom}
      />
    );
  }

  const previewIdentity = previewFile.fileId;
  const collaborationIdentity = collaborationSession?.roomId ?? "local";

  // Reset the controlled comment state when the loaded document changes.
  // Adjust-state-during-render (not an effect) so the freshly-keyed DocxEditor
  // never mounts with the previous file's comments; the new editor re-emits its
  // own parsed comments through `onCommentsChange` on mount.
  if (docxCommentsDocId !== previewIdentity) {
    setDocxCommentsDocId(previewIdentity);
    setDocxComments([]);
    setPendingInitialDocxCommentsSyncDocId(previewIdentity);
  }

  return (
    <div
      ref={composedContainerRef}
      className="flex h-full w-full min-w-0 flex-col"
    >
      {find.isOpen && <DocxFindBar find={find} />}
      {/* Folio editor with AI overlay */}
      <div
        className="min-w-0 flex-1 overflow-hidden"
        // Auto-unlock on first click into the doc body — but only when we
        // can actually unlock. For locked older versions (canUnlock=false)
        // every click would otherwise pop the "latest version required"
        // dialog and the doc becomes unselectable; fall through to the
        // typing-based onReadonlyEditAttempt path instead, which only
        // fires on real edit attempts (not text-selection clicks).
        onMouseDownCapture={
          isUnlocked || !canUnlock ? undefined : handleLockedEditAttempt
        }
      >
        <FileViewerWithAI
          key={`ai-${previewIdentity}`}
          activeFile={{
            editable: canUnlock,
            entityId,
            fileFieldId: fieldId,
            fileName: previewFile.fileName,
          }}
          docxComments={docxComments}
          docxEditable={isUnlocked}
          docxEditSafety={getDocxEditSafety({
            canSafelyEdit: compatibility?.canSafelyEdit,
          })}
          docxEditorRef={editorRef}
          onDocxCommentsChange={handleAiDocxCommentsChange}
          requestDocxEditMode={requestEditMode}
          workspaceId={workspaceId}
        >
          <DocxEditor
            key={`docx-${previewIdentity}-${collaborationIdentity}`}
            ref={editorRef}
            autoOpenReviewSidebar={false}
            className="folio-docx-preview folio-peek h-full"
            comments={docxComments}
            onCommentsChange={handleEditorDocxCommentsChange}
            documentBuffer={editorBuffer}
            initialZoom={targetZoom}
            mode={isUnlocked ? editorMode : "viewing"}
            onModeChange={handleEditorModeChange}
            onCompatibilityChange={handleCompatibilityChange}
            onAnonymizationMatchesChange={handleAnonymizationMatchesChange}
            onSelectionTextChange={handleSelectionTextChange}
            onAnonymizationTermClick={handleAnonymizationTermClick}
            selectedAnonymizationCanonical={sidebarSelectedCanonical}
            anonymizationSelectionSeq={sidebarSelectionSeq}
            onEditorViewReady={setEditorViewForAnonymization}
            showToolbar={showActionBar ? true : isUnlocked}
            toolbarExtra={toolbarExtra}
            {...(activeCollaboration !== undefined
              ? { collaboration: activeCollaboration }
              : {})}
            {...(isUnlocked ? { onChange: handleChange } : {})}
            onReadonlyEditAttempt={handleLockedEditAttempt}
            {...(initialScrollTop !== undefined ? { initialScrollTop } : {})}
            {...(onScrollTopChange !== undefined ? { onScrollTopChange } : {})}
            loadingIndicator={
              <DocxEditorLoadingFallback
                label={t("folio.loadingDocument")}
                scaleOffset={scaleOffset}
                showActionBar={showActionBar}
                stylePickerLabel={lastStyleLabel}
                stylePickerLabelStyle={lastStyleLabelStyle}
                toolbarExtra={toolbarExtra}
                zoom={targetZoom}
              />
            }
            preserveDocumentWhileLoading
          />
          {/* Floating bottom-center review stepper for the AI's pending
              DOCX suggestions. Rendered inside the FileViewerWithAI
              positioned container so it shares the chat composer's
              coordinate space (it clears the composer at `bottom-24`).
              Returns null unless this entity has pending suggestions. */}
          <ReviewBar
            docxEditable={isUnlocked}
            docxEditorRef={editorRef}
            entityId={entityId}
            persistence={{ type: "workspace", workspaceId }}
            requestDocxEditMode={requestEditMode}
          />
        </FileViewerWithAI>
      </div>
    </div>
  );
};

type ResolveAndPreserveDocxEditorBufferOptions = {
  collaborationSeedBuffer: ArrayBuffer | null;
  fieldId: string;
  isCollaborativeEditing: boolean;
  lastEditingBufferRef: RefObject<ArrayBuffer | null>;
  preservedLoadedBufferRef: RefObject<{
    buffer: ArrayBuffer;
    fieldId: string;
  } | null>;
  previewBuffer: ArrayBuffer | undefined;
  state: EditSessionState;
};

const resolveAndPreserveDocxEditorBuffer = ({
  collaborationSeedBuffer,
  fieldId,
  isCollaborativeEditing,
  lastEditingBufferRef,
  preservedLoadedBufferRef,
  previewBuffer,
  state,
}: ResolveAndPreserveDocxEditorBufferOptions) => {
  const preservedLoadedBufferSnapshot = preservedLoadedBufferRef.current;
  const preservedLoadedBuffer =
    preservedLoadedBufferSnapshot?.fieldId === fieldId
      ? preservedLoadedBufferSnapshot.buffer
      : null;
  const editorBuffer = selectDocxBrowserEditorBuffer({
    collaborationSeedBuffer,
    isCollaborativeEditing,
    lastEditingBuffer: lastEditingBufferRef.current,
    preservedLoadedBuffer,
    previewBuffer,
    state,
  });
  if (
    (state.status === "editing" || isCollaborativeEditing) &&
    editorBuffer !== undefined
  ) {
    lastEditingBufferRef.current = editorBuffer;
    preservedLoadedBufferRef.current = null;
  }
  return editorBuffer;
};

type UseDocxBrowserCollaborationOptions = {
  canUnlock: boolean;
  entityId: string;
  externalCollaboration?: DocxEditorCollaboration | undefined;
  initiallyRequested: boolean;
  propertyId: string;
  workspaceId: string;
};

type CollaborationRequestState =
  | { status: "automatic" }
  | { status: "cancelled"; targetKey: string }
  | { status: "requested"; targetKey: string };

const useDocxBrowserCollaboration = ({
  canUnlock,
  entityId,
  externalCollaboration,
  initiallyRequested,
  propertyId,
  workspaceId,
}: UseDocxBrowserCollaborationOptions) => {
  const targetKey = `${workspaceId}:${entityId}:${propertyId}`;
  const [requestState, setRequestState] = useState(
    (): CollaborationRequestState => ({ status: "automatic" }),
  );
  const requested = (() => {
    if (
      requestState.status === "automatic" ||
      requestState.targetKey !== targetKey
    ) {
      return initiallyRequested;
    }

    switch (requestState.status) {
      case "requested":
        return true;
      case "cancelled":
        return false;
      default: {
        const exhaustive: never = requestState;
        return exhaustive;
      }
    }
  })();
  // Read the identity from the provider, not from route context. The editor
  // is persistent chrome: the inspector keeps it mounted across navigation,
  // so a strict `useRouteContext({ from: "/_protected" })` throws the moment
  // the user opens a route outside that tree (`/law/*` is top level).
  // `AuthenticatedUserProvider` wraps both trees, and the maybe- variant keeps
  // the editor renderable on public law routes that have no user at all.
  const currentUser = useMaybeAuthenticatedUser();
  const collaborationEnabled =
    env.VITE_FEATURE_FOLIO_COLLAB && env.VITE_COLLAB_URL !== undefined;
  const collaborationState = useFolioCollaborationRoom({
    enabled: collaborationEnabled && requested && canUnlock,
    entityId,
    propertyId,
    user: currentUser
      ? {
          color: colorFromStableId(currentUser.id),
          id: currentUser.id,
          image: currentUser.image ?? null,
          name:
            getDisplayName(currentUser.name, currentUser.email) ??
            currentUser.email,
        }
      : null,
    workspaceId,
  });
  const collaborationSession = collaborationState.room;
  const cancelCollaboration = useCallback(() => {
    setRequestState((previous) =>
      previous.status === "cancelled" && previous.targetKey === targetKey
        ? previous
        : { status: "cancelled", targetKey },
    );
  }, [targetKey]);
  const requestCollaboration = useCallback(() => {
    setRequestState((previous) =>
      previous.status === "requested" && previous.targetKey === targetKey
        ? previous
        : { status: "requested", targetKey },
    );
  }, [targetKey]);

  return {
    activeCollaboration:
      collaborationSession?.collaboration ?? externalCollaboration,
    cancelCollaboration,
    collaborationEnabled,
    collaborationSession,
    collaborationState,
    canEditCollaboratively:
      collaborationSession !== null && collaborationState.status !== "readOnly",
    isCollaborativeEditing: collaborationSession !== null,
    requestCollaboration,
  };
};

const AutosaveIndicator = ({ status }: { status: AutosaveStatus }) => {
  const t = useTranslations();
  const isSynced = status === "synced";
  const isSyncing = status === "syncing";

  return (
    <span
      aria-label={isSynced ? t("folio.synced") : t("folio.syncing")}
      className="text-foreground-ghost inline-flex h-8 w-8 items-center justify-center"
      role="status"
    >
      {(() => {
        if (isSynced) {
          return <CheckCircle2Icon className="size-3.5" />;
        }
        if (isSyncing) {
          return (
            <RefreshCwIcon className="size-3.5 motion-safe:animate-spin" />
          );
        }
        return <RefreshCwIcon className="size-3.5 opacity-45" />;
      })()}
    </span>
  );
};

const CollaborationStatusIndicator = ({
  status,
}: {
  status: "connecting" | "readOnly" | "reconnecting" | "synced";
}) => {
  const t = useTranslations();
  const label = (() => {
    switch (status) {
      case "connecting":
        return t("folio.syncing");
      case "readOnly":
        return t("folio.viewOnly");
      case "reconnecting":
        return t("common.reconnecting");
      case "synced":
        return t("folio.synced");
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  })();
  const icon = (() => {
    switch (status) {
      case "synced":
        return <CheckCircle2Icon className="size-3.5" />;
      case "readOnly":
        return <EyeIcon className="size-3.5" />;
      case "connecting":
      case "reconnecting":
        return <RefreshCwIcon className="size-3.5 motion-safe:animate-spin" />;
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  })();

  return (
    <span
      className="text-foreground-muted inline-flex min-h-11 items-center gap-1.5 px-2 text-xs"
      role="status"
    >
      {icon}
      <span>{label}</span>
    </span>
  );
};

type CollaborationPresenceUser = {
  id: string;
  image: string | null;
  name: string;
};

const readCollaborationPresenceUser = (
  value: unknown,
): CollaborationPresenceUser | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!("user" in value)) {
    return null;
  }
  const user = value.user;
  if (user === null || typeof user !== "object" || Array.isArray(user)) {
    return null;
  }
  if (!("id" in user) || !("image" in user) || !("name" in user)) {
    return null;
  }
  const { id, image, name } = user;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    (image !== null && typeof image !== "string")
  ) {
    return null;
  }
  return { id, image, name };
};

const readCollaborationPresence = (
  awareness: NonNullable<DocxEditorCollaboration["awareness"]>,
) => {
  const users = new Map<string, CollaborationPresenceUser>();
  for (const state of awareness.getStates().values()) {
    const user = readCollaborationPresenceUser(state);
    if (user !== null) {
      users.set(user.id, user);
    }
  }
  return [...users.values()];
};

const hasSameCollaborationPresence = (
  previous: CollaborationPresenceUser[],
  next: CollaborationPresenceUser[],
) =>
  previous.length === next.length &&
  previous.every((user, index) => {
    const nextUser = next.at(index);
    return (
      nextUser !== undefined &&
      user.id === nextUser.id &&
      user.image === nextUser.image &&
      user.name === nextUser.name
    );
  });

const CollaborationPresence = ({
  awareness,
}: {
  awareness: NonNullable<DocxEditorCollaboration["awareness"]>;
}) => {
  const [users, setUsers] = useState(() =>
    readCollaborationPresence(awareness),
  );

  useExternalSyncEffect(() => {
    const updatePresence = () => {
      const next = readCollaborationPresence(awareness);
      setUsers((previous) =>
        hasSameCollaborationPresence(previous, next) ? previous : next,
      );
    };
    updatePresence();
    awareness.on("change", updatePresence);
    return () => awareness.off("change", updatePresence);
  }, [awareness]);

  return (
    <ul className="flex min-h-11 items-center -space-x-2 px-2">
      {users.map((user) => (
        <li
          aria-label={user.name}
          className="border-background rounded-full border-2"
          key={user.id}
          title={user.name}
        >
          <UserIdentityAvatar
            className="size-7 text-[0.625rem]"
            image={user.image}
            name={user.name}
          />
        </li>
      ))}
    </ul>
  );
};

const defaultDocxBrowserEditorErrorFallback = ({
  reset,
}: {
  reset: () => void;
}) => <DocxBrowserEditorErrorFallback onRetry={reset} />;

const DocxBrowserEditorPendingFallback = ({
  actionBarControls,
  scaleOffset = 0,
  showActionBar = true,
}: DocxBrowserEditorProps) => {
  const t = useTranslations();
  const toolbarExtra =
    showActionBar || actionBarControls !== undefined
      ? actionBarControls
      : undefined;

  return (
    <DocxEditorLoadingFallback
      label={t("folio.loadingDocument")}
      scaleOffset={scaleOffset}
      showActionBar={showActionBar}
      toolbarExtra={toolbarExtra}
    />
  );
};

type DocxEditorLoadingFallbackProps = {
  label: string;
  scaleOffset: number;
  showActionBar: boolean;
  stylePickerLabel?: string | undefined;
  stylePickerLabelStyle?: CSSProperties | undefined;
  toolbarExtra?: ReactNode | undefined;
  zoom?: number | undefined;
};

const DocxEditorLoadingFallback = ({
  label,
  scaleOffset,
  showActionBar,
  stylePickerLabel,
  stylePickerLabelStyle,
  toolbarExtra,
  zoom,
}: DocxEditorLoadingFallbackProps) => (
  <div aria-live="polite" className="flex h-full w-full flex-col" role="status">
    <DocxLoadingToolbar
      showActionBar={showActionBar}
      stylePickerLabel={stylePickerLabel}
      stylePickerLabelStyle={stylePickerLabelStyle}
      toolbarExtra={toolbarExtra}
    />
    <DocxLoadingShell scaleOffset={scaleOffset} zoom={zoom} />
    <span className="sr-only">{label}</span>
  </div>
);

type DocxLoadingToolbarProps = {
  showActionBar: boolean;
  stylePickerLabel?: string | undefined;
  stylePickerLabelStyle?: CSSProperties | undefined;
  toolbarExtra?: ReactNode | undefined;
};

const DocxLoadingToolbar = ({
  showActionBar,
  stylePickerLabel,
  stylePickerLabelStyle,
  toolbarExtra,
}: DocxLoadingToolbarProps) => {
  if (!showActionBar) {
    return null;
  }

  return (
    <div className="pointer-events-none z-50 flex shrink-0 flex-col gap-0 bg-[var(--doc-page)] [&_[data-slot=select-trigger]:focus-visible]:ring-0 [&_[data-slot=select-trigger]:hover]:!bg-transparent [&_[data-slot=select-trigger][data-pressed]]:!bg-transparent [&_button:active]:!bg-transparent [&_button:focus-visible]:ring-0 [&_button:hover]:!bg-transparent [&_button[data-pressed]]:!bg-transparent [&_button[data-pressed]]:shadow-none">
      <FolioUIProvider components={folioUIComponents}>
        <FormattingBar
          canRedo={false}
          canUndo={false}
          currentFormatting={{}}
          onFormat={noop}
          onRedo={noop}
          onUndo={noop}
          priorityExtra={<DocxLoadingPriorityExtra />}
          stylePickerLabel={stylePickerLabel}
          stylePickerLabelStyle={stylePickerLabelStyle}
        >
          {toolbarExtra}
        </FormattingBar>
      </FolioUIProvider>
    </div>
  );
};

const DocxLoadingPriorityExtra = () => {
  const t = useTranslations("folio");

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        onClick={noop}
        onMouseDown={(e) => e.preventDefault()}
        aria-pressed={false}
        aria-label={t("toggleTrackChanges")}
        className="h-8 min-w-[140px] justify-start gap-1.5 rounded-md border-transparent px-2 text-xs text-[var(--doc-text-muted)] shadow-none hover:border-[var(--doc-border)] hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]"
        size="xs"
        title={t("toggleTrackChanges")}
        variant="ghost"
      >
        <PenLineIcon className="size-3.5" />
        <span className="truncate whitespace-nowrap">{t("trackingOff")}</span>
      </Button>
      <StSelect value="all-markup" onValueChange={noop}>
        <StSelectTrigger
          size="sm"
          className="h-8 min-h-0 w-[132px] min-w-0 shrink-0 border-transparent bg-transparent text-xs text-[var(--doc-text-muted)] shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)]"
        >
          <EyeIcon size={14} className="shrink-0" />
          <StSelectValue />
        </StSelectTrigger>
        <StSelectPopup>
          <StSelectItem value="all-markup">
            {t("markupView.allMarkup")}
          </StSelectItem>
          <StSelectItem value="simple-markup">
            {t("markupView.simple")}
          </StSelectItem>
          <StSelectItem value="no-markup">
            {t("markupView.noMarkup")}
          </StSelectItem>
          <StSelectItem value="original">
            {t("markupView.original")}
          </StSelectItem>
        </StSelectPopup>
      </StSelect>
    </div>
  );
};

const DocxBrowserEditorErrorFallback = ({
  onRetry,
}: {
  onRetry: () => void;
}) => {
  const t = useTranslations();

  return (
    <StatusMessage
      actionButton={
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("common.tryAgain")}
        </Button>
      }
      className="h-full w-full"
      description={t("common.unexpectedError")}
      status="error"
      title={t("common.somethingWentWrong")}
    />
  );
};

type EditSessionErrorMessageKey =
  | "folio.editAuthRequired"
  | "folio.editPermissionDenied"
  | "folio.editDownloadFailed"
  | "folio.editSessionTakenOver"
  | "folio.editOpenFailed";

const editSessionErrorDescriptionKey = (
  reason: EditSessionErrorReason,
): EditSessionErrorMessageKey => {
  switch (reason) {
    case "authRequired":
      return "folio.editAuthRequired";
    case "permissionDenied":
      return "folio.editPermissionDenied";
    case "downloadFailed":
      return "folio.editDownloadFailed";
    case "takenOver":
      return "folio.editSessionTakenOver";
    case "unknown":
      return "folio.editOpenFailed";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
};
