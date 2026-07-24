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

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  EyeIcon,
  LockOpenIcon,
  PenLineIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

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
import { Button } from "@stll/ui/components/button";
import {
  Select as StSelect,
  SelectItem as StSelectItem,
  SelectPopup as StSelectPopup,
  SelectTrigger as StSelectTrigger,
  SelectValue as StSelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { useActiveDocxStore } from "@/components/ai-suggestions/active-docx-store";
import type { ActiveDocxRegistrationToken } from "@/components/ai-suggestions/active-docx-store";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { ReviewBar } from "@/components/ai-suggestions/review-bar";
import { useReviewStore } from "@/components/ai-suggestions/review-store";
import "@stll/folio-react/editor.css";

import { useAutocompleteStream } from "@/components/autocomplete/use-autocomplete-stream";
import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";
import { DocxEditor } from "@/components/docx/app-docx-editor";
import type { DocxComments } from "@/components/docx/app-docx-editor";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { StatusMessage } from "@/components/route-components";
import Tooltip from "@/components/tooltip";
import { env } from "@/env";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { anonymizeChatTextInWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import { detached } from "@/lib/detached";
import { folioUIComponents } from "@/lib/folio-ui-components";
import { composeRefs } from "@/lib/utils";
import { DocxLoadingShell } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-loading-shell";
import { useDocxBlockScroll } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/use-docx-block-scroll";
import { useFolioCollaborationSession } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/use-folio-collaboration-session";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import {
  useInspectorStore,
  useIsAnonymizationActive,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useSyncDocxSuggestions } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-docx-suggestions";
import { anonymizationAllowlistOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-allowlist";
import "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-docx.css";
import { anonymizationTermsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-terms";

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
import type { EditSessionErrorReason } from "./use-edit-session";
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
  errorFallback?: ((props: { reset: () => void }) => ReactNode) | undefined;
  onError?: ((error: Error) => void) | undefined;
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
      <DocxBrowserEditorContent {...props} />
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
    onCompatibilityChange,
    onBlockedUnlock,
    onUnlockedChange,
    onSaved,
    onReadonlyEditAttempt,
    onScrollTopChange,
    scaleOffset = 0,
    showActionBar = true,
  } = props;
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
    useInspectorStore.getState().markAnonymizationPipelineStarted(fieldId);
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
      useInspectorStore.getState().markAnonymizationPipelineRan(fieldId);
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
      useInspectorStore.getState().markAnonymizationPipelineStarted(fieldId);
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
      const { publishAnonymizationMatches } = useInspectorStore.getState();
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
    const { clearAnonymizationMatches } = useInspectorStore.getState();
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
      useInspectorStore
        .getState()
        .publishDocumentTextSelection(fieldId, single);
    },
    [fieldId],
  );
  useExternalSyncEffect(
    () => () => {
      useInspectorStore.getState().clearDocumentTextSelection(fieldId);
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
      useInspectorStore
        .getState()
        .selectAnonymizationTerm(canonical, label, "doc", fieldId);
    },
    [fieldId],
  );
  const sidebarSelectedCanonical = useInspectorStore((s) =>
    s.anonymizationSelection.source === "sidebar" &&
    s.anonymizationSelection.fieldId === fieldId
      ? s.anonymizationSelection.canonical
      : null,
  );
  const sidebarSelectionSeq = useInspectorStore((s) =>
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
  const t = useTranslations();
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
    fieldId,
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
    isCollaborativeEditing,
    requestCollaboration,
  } = collaborationRuntime;

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

  const saveActiveCheckpoint =
    collaborationSession?.saveCheckpoint ?? saveDesktopCheckpoint;
  const finalizeActiveSession =
    collaborationSession?.finalize ?? finalizeDesktopSession;
  const cancelActiveSession = useCallback(async () => {
    if (collaborationSession !== null) {
      const cancelled = await collaborationSession.cancel();
      if (!cancelled) {
        stellaToast.add({
          description: t("folio.saveCheckpointFailedDescription"),
          title: t("folio.saveCheckpointFailedTitle"),
          type: "error",
        });
        return;
      }

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
    t,
  ]);

  useExternalSyncEffect(() => {
    if (optimisticPreviewRef.current?.fieldId === fieldId) {
      return;
    }
    optimisticPreviewRef.current = null;
    finalizedBufferRef.current = null;
    lastEditingBufferRef.current = null;
    hasSessionChangesRef.current = false;
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
      useInspectorStore.getState().requestDocxEdit(fieldId);
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
    detached(requestEditMode(), "DocxBrowserEditorContent");
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
      requestCollaboration();
      return;
    }
    didOpenRef.current = true;
    errorToastShownRef.current = false;
    detached(open(), "DocxBrowserEditorContent");
  }, [
    compatibility,
    collaborationEnabled,
    isEditing,
    open,
    previewFile,
    requestCollaboration,
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

  const isUnlocked = isCollaborativeEditing || state.status === "editing";
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
  useExternalSyncEffect(() => {
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
    // eslint-disable-next-line react/react-compiler -- the exhaustive-deps exception below intentionally opts this edit-mode effect out of compiler memoization
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `isUnlocked` deliberately excluded; see block comment above.
  }, [entityId, fieldId, requestEditMode]);

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
    detached(triggerCheckpointSave(), "DocxBrowserEditorContent");
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
      detached(triggerCheckpointSave(), "handler");
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

    setAutosaveStatus("pending");
    hasSessionChangesRef.current = true;
    markDirty();
    clearQueuedChangeCheckpoint();
    scheduleChangeCheckpointSave();
  }, [
    clearQueuedChangeCheckpoint,
    isUnlocked,
    markDirty,
    scheduleChangeCheckpointSave,
    setAutosaveStatus,
  ]);

  const handleAiDocxCommentsChange = (comments: DocxComments) => {
    setPendingInitialDocxCommentsSyncDocId(null);
    setDocxComments(comments);
    handleChange();
  };

  const handleEditorDocxCommentsChange = (comments: DocxComments) => {
    const isInitialEditorSync = pendingInitialDocxCommentsSyncDocId !== null;
    setPendingInitialDocxCommentsSyncDocId(null);
    const commentsChanged =
      JSON.stringify(docxComments) !== JSON.stringify(comments);
    setDocxComments(comments);
    if (isInitialEditorSync) {
      return;
    }
    if (commentsChanged) {
      handleChange();
    }
  };

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
      if (isCollaborativeEditing) {
        if (collaborationSession === null) {
          return;
        }

        const finalized = await collaborationSession.finalize();
        if (finalized === null) {
          setAutosaveStatus("pending");
          stellaToast.add({
            description: t("folio.saveCheckpointFailedDescription"),
            title: t("folio.editSaveFailedTitle"),
            type: "error",
          });
          return;
        }
        if (finalized.outcome === "finalized") {
          onSaved?.(finalized.fieldId);
        }
        onClose();
        return;
      }
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
    if (isCollaborativeEditing) {
      if (collaborationSession === null) {
        return;
      }

      const collaborativeFinalized = await collaborationSession.finalize();
      if (collaborativeFinalized === null) {
        hasSessionChangesRef.current = true;
        setAutosaveStatus("pending");
        stellaToast.add({
          description: t("folio.saveCheckpointFailedDescription"),
          title: t("folio.editSaveFailedTitle"),
          type: "error",
        });
        return;
      }
      if (collaborativeFinalized.outcome === "finalized") {
        onSaved?.(collaborativeFinalized.fieldId);
      }
      onClose();
      return;
    }

    await finalizeActiveSession();
  }, [
    cancelActiveSession,
    clearQueuedChangeCheckpoint,
    collaborationSession,
    entityId,
    fieldId,
    finalizeActiveSession,
    isCollaborativeEditing,
    isDirty,
    onClose,
    onSaved,
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
      useInspectorStore.getState().requestDocxEdit(fieldId);
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
      detached(open(), "DocxBrowserEditorContent");
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
    detached(handleFinalize(), "DocxBrowserEditorContent");
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
          detached(handleFinalize(), "finalize");
        }
      },
      flushPendingChanges,
      print: () => {
        editorRef.current?.print();
      },
      unlock: () => {
        detached(requestEditMode(), "unlock");
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
  const preservedLoadedBufferSnapshot = preservedLoadedBufferRef.current;
  const preservedLoadedBuffer =
    preservedLoadedBufferSnapshot?.fieldId === fieldId
      ? preservedLoadedBufferSnapshot.buffer
      : null;
  const lastEditingBuffer = lastEditingBufferRef.current;
  const collaborationSeedBuffer =
    collaborationSession?.seedDocumentBuffer ?? null;
  const editorBuffer = selectDocxBrowserEditorBuffer({
    collaborationSeedBuffer,
    isCollaborativeEditing,
    lastEditingBuffer,
    preservedLoadedBuffer,
    previewBuffer: previewFile?.buffer,
    state,
  });
  if (
    (state.status === "editing" || isCollaborativeEditing) &&
    editorBuffer !== undefined
  ) {
    lastEditingBufferRef.current = editorBuffer;
    preservedLoadedBufferRef.current = null;
  }
  const finishEditingLabel = t("folio.finishEditing");

  const toolbarExtra = (() => {
    if (showActionBar || actionBarControls !== undefined) {
      return (
        <>
          {actionBarControls}
          {showActionBar && isUnlocked && (
            <>
              <Tooltip
                content={finishEditingLabel}
                render={
                  <Button
                    aria-label={finishEditingLabel}
                    className="px-2"
                    disabled={
                      state.status === "opening" ||
                      state.status === "saving" ||
                      collaborationState.status === "opening"
                    }
                    onClick={handleToggleLock}
                    size="sm"
                    variant="ghost"
                  >
                    <LockOpenIcon />
                    <span>{finishEditingLabel}</span>
                  </Button>
                }
              />
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

  if (collaborationState.status === "error") {
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

  const lastStyleLabel = lastStyleLabelRef.current;
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
  const collaborationIdentity = collaborationSession?.sessionId ?? "local";

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
            documentKey={previewIdentity}
            initialZoom={targetZoom}
            mode={isUnlocked ? editorMode : "viewing"}
            onModeChange={(mode) => {
              if (mode !== "viewing") {
                setEditorMode(mode);
              }
            }}
            onCompatibilityChange={(nextCompatibility) => {
              if (previewFileQuery.isPlaceholderData) {
                return;
              }

              setCompatibilityState({
                targetKey: editTargetKey,
                value: nextCompatibility,
              });
              onCompatibilityChange?.(nextCompatibility);
            }}
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
              coordinate space (it clears the composer at `bottom-28`).
              Returns null unless this entity has pending suggestions. */}
          <ReviewBar
            docxEditable={isUnlocked}
            docxEditorRef={editorRef}
            entityId={entityId}
            requestDocxEditMode={requestEditMode}
            workspaceId={workspaceId}
          />
        </FileViewerWithAI>
      </div>
    </div>
  );
};

type UseDocxBrowserCollaborationOptions = {
  canUnlock: boolean;
  entityId: string;
  externalCollaboration?: DocxEditorCollaboration | undefined;
  fieldId: string;
  initiallyRequested: boolean;
  propertyId: string;
  workspaceId: string;
};

type CollaborationRequestState = {
  requested: boolean;
  targetKey: string;
};

const useDocxBrowserCollaboration = ({
  canUnlock,
  entityId,
  externalCollaboration,
  fieldId,
  initiallyRequested,
  propertyId,
  workspaceId,
}: UseDocxBrowserCollaborationOptions) => {
  const targetKey = `${workspaceId}:${entityId}:${propertyId}:${fieldId}`;
  const [requestState, setRequestState] = useState<CollaborationRequestState>({
    requested: initiallyRequested,
    targetKey,
  });
  const requested =
    requestState.targetKey === targetKey
      ? requestState.requested
      : initiallyRequested;
  const currentUser = useRouteContext({
    from: "/_protected",
    select: (ctx) => ({
      email: ctx.user.email,
      id: ctx.user.id,
      name: ctx.user.name,
    }),
  });
  const collaborationEnabled =
    env.VITE_FEATURE_FOLIO_COLLAB && env.VITE_COLLAB_URL !== undefined;
  const collaborationState = useFolioCollaborationSession({
    enabled: collaborationEnabled && requested && canUnlock,
    entityId,
    fieldId,
    propertyId,
    user: {
      color: colorFromStableId(currentUser.id),
      name: currentUser.name ?? currentUser.email,
    },
    workspaceId,
  });
  useExternalSyncEffect(() => {
    setRequestState({ requested: initiallyRequested, targetKey });
  }, [initiallyRequested, targetKey]);
  const collaborationSession =
    collaborationState.status === "ready" ? collaborationState.session : null;
  const cancelCollaboration = useCallback(() => {
    setRequestState({ requested: false, targetKey });
  }, [targetKey]);
  const requestCollaboration = useCallback(() => {
    setRequestState({ requested: true, targetKey });
  }, [targetKey]);

  return {
    activeCollaboration:
      collaborationSession?.collaboration ?? externalCollaboration,
    cancelCollaboration,
    collaborationEnabled,
    collaborationSession,
    collaborationState,
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
          return <RefreshCwIcon className="size-3.5 animate-spin" />;
        }
        return <RefreshCwIcon className="size-3.5 opacity-45" />;
      })()}
    </span>
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
