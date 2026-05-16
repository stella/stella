/**
 * DocxBrowserEditor — wrapper that manages the edit session lifecycle
 * and renders the Folio DocxEditor.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
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
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import { FormattingBar, setAnonymizationTermsMeta } from "@stll/folio";
import type {
  AnonymizationTerm,
  DocxCompatibility,
  DocxEditorCollaboration,
  DocxEditorRef,
  EditorMode,
} from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import {
  Select as StSelect,
  SelectItem as StSelectItem,
  SelectPopup as StSelectPopup,
  SelectTrigger as StSelectTrigger,
  SelectValue as StSelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import "@stll/folio/editor.css";

import { useActiveDocxStore } from "@/components/ai-suggestions/active-docx-store";
import type { ActiveDocxRegistrationToken } from "@/components/ai-suggestions/active-docx-store";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { StatusMessage } from "@/components/route-components";
import Tooltip from "@/components/tooltip";
import { env } from "@/env";
import { anonymizeChatTextInWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import { DocxLoadingShell } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-loading-shell";
import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-preview-zoom";
import { useDocxBlockScroll } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/use-docx-block-scroll";
import { useFolioCollaborationSession } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/use-folio-collaboration-session";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { useIsAnonymizationActive } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-active-store";
import { useAnonymizationMatchesStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-matches-store";
import { useAnonymizationSelectionStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-selection-store";
import { useDocumentTextSelectionStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/document-text-selection-store";
import { anonymizationAllowlistOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-allowlist";
import { anonymizationTermsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-terms";
import "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-docx.css";

import {
  getDocxEditBlockReason,
  selectDocxBrowserEditorBuffer,
  selectPreviewFile,
  shouldFinalizeEditSession,
} from "./docx-browser-editor.logic";
import type { OptimisticPreviewFile } from "./docx-browser-editor.logic";
import type { EditSessionErrorReason } from "./use-edit-session";
import { useEditSession } from "./use-edit-session";

const DocxEditor = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

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

type AutosaveStatus = "synced" | "pending" | "syncing";

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
  const workspaceAnonymizationTerms = useMemo<AnonymizationTerm[]>(
    () =>
      anonymizationTermsQuery.data?.entries.map((entry) => ({
        canonical: entry.canonical,
        label: entry.label,
        variants: entry.variants,
      })) ?? [],
    [anonymizationTermsQuery.data],
  );
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
  useEffect(() => {
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
    // before that run can call `markPipelineStarted`
    // itself). The first `run()` also calls it again
    // (idempotent set-add); subsequent runs flip it on
    // around each worker call.
    useAnonymizationMatchesStore.getState().markPipelineStarted(fieldId);
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
      useAnonymizationMatchesStore.getState().markPipelineRan(fieldId);
    const run = () => {
      if (cancelled) {
        return;
      }
      if (Date.now() < inFlightUntil) {
        return;
      }
      const text = view.state.doc.textContent;
      const excluded = excludedCanonicalsRef.current;
      const cacheKey = `${[...excluded].sort().join("|")}~${text}`;
      if (text.length === 0) {
        // Empty doc: nothing to detect. Release the
        // "in flight" lock so the facet exits the
        // "Detecting…" placeholder instead of stalling
        // on the mount-time mark.
        markRan();
        return;
      }
      if (cacheKey === lastDeliveredKey) {
        // Already delivered for this exact text +
        // exclusions; no-op without flipping the
        // started state (we're not running anything).
        return;
      }
      inFlightUntil = Date.now() + IN_FLIGHT_TIMEOUT_MS;
      // (Re-)mark started: handles reruns triggered by
      // edits or allowlist changes after the first run
      // already called `markPipelineRan`.
      useAnonymizationMatchesStore.getState().markPipelineStarted(fieldId);
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
          const byCanonical = new Map<string, AnonymizationTerm>();
          for (const pair of result.pairs) {
            const key = `${pair.label} ${pair.original.toLowerCase()}`;
            if (!byCanonical.has(key)) {
              byCanonical.set(key, {
                canonical: pair.original,
                label: pair.label,
              });
            }
          }
          setDetectedAnonymizationTerms([...byCanonical.values()]);
          markRan();
        })
        .catch(() => {
          inFlightUntil = 0;
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
  const excludedCanonicalsSet = useMemo(() => {
    const set = new Set<string>();
    for (const entry of allowlistQuery.data?.entries ?? []) {
      set.add(entry.canonical.toLocaleLowerCase());
    }
    return set;
  }, [allowlistQuery.data]);
  // Hold the latest list in a ref so the chat-anon polling effect
  // sees fresh exclusions without re-installing its heartbeat on
  // every keystroke / mutation.
  const excludedCanonicalsRef = useRef<readonly string[]>([]);
  useEffect(() => {
    excludedCanonicalsRef.current = [...excludedCanonicalsSet];
    // Kick the detection right away so worker-found terms that
    // the user just added to the allowlist disappear without
    // having to wait up to 2s for the next heartbeat tick.
    runDetectionRef.current?.();
  }, [excludedCanonicalsSet]);
  const mergedAnonymizationTerms = useMemo<AnonymizationTerm[]>(() => {
    if (!isAnonymizationActive) {
      return [];
    }
    const filteredWorkspace =
      excludedCanonicalsSet.size === 0
        ? workspaceAnonymizationTerms
        : workspaceAnonymizationTerms.filter(
            (term) =>
              !excludedCanonicalsSet.has(term.canonical.toLocaleLowerCase()),
          );
    return [...filteredWorkspace, ...detectedAnonymizationTerms];
  }, [
    isAnonymizationActive,
    workspaceAnonymizationTerms,
    detectedAnonymizationTerms,
    excludedCanonicalsSet,
  ]);
  // Dispatch the live term list into the plugin. We can't simply
  // read matches right after `dispatch` because DOCX content
  // loads asynchronously: the first dispatch hits an empty doc
  // (matches=[]), then PM's docChanged transaction rebuilds
  // matches *later* without our effect re-firing. Publishing is
  // handled by the polling effect below.
  useEffect(() => {
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
      const { publish } = useAnonymizationMatchesStore.getState();
      if (!isAnonymizationActive) {
        return;
      }
      const countByCanonical = new Map<string, number>();
      const labelByCanonical = new Map<string, string>();
      for (const match of matches) {
        countByCanonical.set(
          match.canonical,
          (countByCanonical.get(match.canonical) ?? 0) + 1,
        );
        if (!labelByCanonical.has(match.canonical)) {
          labelByCanonical.set(match.canonical, match.label);
        }
      }
      publish(fieldId, {
        totalMatches: matches.length,
        countByCanonical,
        labelByCanonical,
      });
    },
    [fieldId, isAnonymizationActive],
  );
  useEffect(() => {
    const { clear } = useAnonymizationMatchesStore.getState();
    if (!isAnonymizationActive) {
      clear(fieldId);
    }
    return () => {
      clear(fieldId);
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
      const single = selection.text.replace(/\s+/g, " ").trim();
      if (single.length < 2 || single.length > 200) {
        return;
      }
      useDocumentTextSelectionStore.getState().publish(fieldId, single);
    },
    [fieldId],
  );
  useEffect(
    () => () => {
      useDocumentTextSelectionStore.getState().clear(fieldId);
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
      useAnonymizationSelectionStore
        .getState()
        .select(canonical, label, "doc", fieldId);
    },
    [fieldId],
  );
  const sidebarSelectedCanonical = useAnonymizationSelectionStore((s) =>
    s.source === "sidebar" && s.fieldId === fieldId ? s.canonical : null,
  );
  const sidebarSelectionSeq = useAnonymizationSelectionStore((s) =>
    s.source === "sidebar" && s.fieldId === fieldId ? s.seq : 0,
  );
  const didOpenRef = useRef(false);
  const errorToastShownRef = useRef(false);
  const lastStyleLabelRef = useRef("Normal");
  const lastStyleLabelStyleRef = useRef<CSSProperties | undefined>(undefined);
  const lockedEditPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
  const [isPromptingUnlock, setIsPromptingUnlock] = useState(false);
  const [autosaveStatus, setAutosaveStatus] =
    useState<AutosaveStatus>("synced");
  const targetZoom = useDocxFitZoom(containerRef, scaleOffset, 0.85);
  const t = useTranslations();
  const previewPlaceholder =
    optimisticPreviewRef.current?.fieldId === fieldId
      ? optimisticPreviewRef.current.file
      : undefined;
  const previewFileQuery = useQuery({
    ...fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
    ...(previewPlaceholder !== undefined
      ? { placeholderData: previewPlaceholder }
      : { placeholderData: keepPreviousData }),
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
        optimisticPreview: optimisticPreviewRef.current,
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

  useEffect(() => {
    if (optimisticPreviewRef.current?.fieldId === fieldId) {
      return;
    }
    optimisticPreviewRef.current = null;
    finalizedBufferRef.current = null;
    lastEditingBufferRef.current = null;
    hasSessionChangesRef.current = false;
    preservedLoadedBufferRef.current = null;
    setIsPromptingUnlock(false);
    if (lockedEditPromptTimerRef.current !== null) {
      clearTimeout(lockedEditPromptTimerRef.current);
      lockedEditPromptTimerRef.current = null;
    }
    setCompatibilityState({ targetKey: editTargetKey, value: null });
  }, [editTargetKey, fieldId]);

  const reportUnsupportedEditAttempt = useCallback(() => {
    stellaToast.warning(t("folio.unsupportedDocxEditTitle"), {
      description: t("folio.unsupportedDocxEditDescription"),
    });
    onClose();
  }, [onClose, t]);

  const reportPendingCompatibility = useCallback(() => {
    stellaToast.info(t("folio.checkingDocxEditTitle"), {
      description: t("folio.checkingDocxEditDescription"),
    });
  }, [t]);

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
      reportPendingCompatibility();
      return false;
    }

    if (blockReason === "unsafe") {
      reportUnsupportedEditAttempt();
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
    isCollaborativeEditing,
    open,
    previewFile,
    requestCollaboration,
    reportPendingCompatibility,
    reportUnsupportedEditAttempt,
    state.status,
  ]);

  // Auto-open when this component is used as a direct editor, or when the
  // preview is explicitly unlocked from the shell toolbar.
  useEffect(() => {
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
      reportUnsupportedEditAttempt();
      return;
    }
    if (collaborationEnabled) {
      requestCollaboration();
      return;
    }
    didOpenRef.current = true;
    errorToastShownRef.current = false;
    void open();
  }, [
    compatibility,
    collaborationEnabled,
    isEditing,
    open,
    previewFile,
    requestCollaboration,
    reportUnsupportedEditAttempt,
    state.status,
  ]);

  useEffect(() => {
    if (!isEditing) {
      didOpenRef.current = false;
    }
  }, [isEditing]);

  useLayoutEffect(() => {
    editorRef.current?.setZoom(targetZoom);
  }, [targetZoom]);
  useDocxWheelZoom(containerRef, editorRef);
  useDocxBlockScroll({ editorRef, fieldId });

  useEffect(() => {
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

  useEffect(() => {
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
  useEffect(() => {
    const token = useActiveDocxStore.getState().registerEditor(entityId, {
      editorRef,
      requestEditMode,
      editable: isUnlocked,
    });
    tokenRef.current = token;
    return () => {
      useActiveDocxStore.getState().unregisterEditor(entityId, token);
      if (tokenRef.current === token) {
        tokenRef.current = null;
      }
    };
    // `isUnlocked` is intentionally NOT in deps: this effect owns
    // the register/unregister lifecycle, and the next effect below
    // propagates lock-state changes via `updateEditable`. Including
    // it here would tear down + re-create the registration on every
    // toggle, invalidating the token contract documented above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, requestEditMode]);

  useEffect(() => {
    const token = tokenRef.current;
    if (token === null) {
      return;
    }
    useActiveDocxStore.getState().updateEditable(entityId, isUnlocked, token);
  }, [entityId, isUnlocked]);

  useEffect(() => {
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

  const saveChangeCheckpoint = useCallback(() => {
    const ref = editorRef.current;
    if (!ref) {
      return;
    }

    setAutosaveStatus("syncing");
    void (async () => {
      const buffer = await ref.save({ selective: true });
      if (buffer) {
        const saved = await saveActiveCheckpoint(buffer);
        setAutosaveStatus(saved ? "synced" : "pending");
        return;
      }
      setAutosaveStatus("pending");
    })();
  }, [saveActiveCheckpoint]);

  // Awaitable variant of `saveChangeCheckpoint` for callers that
  // need to wait for the round-trip before navigating (e.g. the
  // sidepeek → full view handoff). Cancels the queued debounced
  // checkpoint so we don't fire it twice.
  const flushPendingChanges = useCallback(async () => {
    const ref = editorRef.current;
    if (!ref) {
      return;
    }
    clearQueuedChangeCheckpoint();
    setAutosaveStatus("syncing");
    const buffer = await ref.save({ selective: true });
    if (!buffer) {
      setAutosaveStatus("pending");
      return;
    }
    const saved = await saveActiveCheckpoint(buffer);
    setAutosaveStatus(saved ? "synced" : "pending");
  }, [clearQueuedChangeCheckpoint, saveActiveCheckpoint]);

  // Cmd+S / Ctrl+S checkpoints only while the document is actively editable.
  useEffect(() => {
    if (!isUnlocked) {
      return undefined;
    }

    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "s") {
        return;
      }

      e.preventDefault();
      clearQueuedChangeCheckpoint();
      const ref = editorRef.current;
      if (!ref) {
        return;
      }

      setAutosaveStatus("syncing");
      void (async () => {
        const buffer = await ref.save({ selective: true });
        if (buffer) {
          const saved = await saveActiveCheckpoint(buffer);
          setAutosaveStatus(saved ? "synced" : "pending");
          return;
        }
        setAutosaveStatus("pending");
      })();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [clearQueuedChangeCheckpoint, isUnlocked, saveActiveCheckpoint]);

  useEffect(
    () => () => {
      clearQueuedChangeCheckpoint();
      if (lockedEditPromptTimerRef.current !== null) {
        clearTimeout(lockedEditPromptTimerRef.current);
      }
    },
    [clearQueuedChangeCheckpoint],
  );

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
  ]);

  const handleFinalize = useCallback(async () => {
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
        await finalizeActiveSession();
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
    const finalized = await finalizeActiveSession();
    if (isCollaborativeEditing) {
      if (finalized?.outcome === "finalized") {
        onSaved?.(finalized.fieldId);
      }
      onClose();
    }
  }, [
    cancelActiveSession,
    clearQueuedChangeCheckpoint,
    fieldId,
    finalizeActiveSession,
    isCollaborativeEditing,
    isDirty,
    onClose,
    onSaved,
    previewFile,
    saveActiveCheckpoint,
    t,
  ]);

  const handleCancel = useCallback(async () => {
    clearQueuedChangeCheckpoint();
    preservedLoadedBufferRef.current = null;
    hasSessionChangesRef.current = false;
    await cancelActiveSession();
  }, [cancelActiveSession, clearQueuedChangeCheckpoint]);

  const flashUnlockControl = useCallback(() => {
    setIsPromptingUnlock(true);
    if (lockedEditPromptTimerRef.current !== null) {
      clearTimeout(lockedEditPromptTimerRef.current);
    }
    lockedEditPromptTimerRef.current = setTimeout(() => {
      lockedEditPromptTimerRef.current = null;
      setIsPromptingUnlock(false);
    }, 1400);
  }, []);

  const handleUnlock = useCallback(() => {
    if (!canUnlock) {
      flashUnlockControl();
      onBlockedUnlock?.();
      return;
    }

    const blockReason = getDocxEditBlockReason({
      canSafelyEdit: compatibility?.canSafelyEdit,
    });
    if (blockReason === "pendingCompatibility") {
      reportPendingCompatibility();
      return;
    }

    if (blockReason === "unsafe") {
      reportUnsupportedEditAttempt();
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
      void open();
    }
  }, [
    canUnlock,
    compatibility?.canSafelyEdit,
    collaborationEnabled,
    flashUnlockControl,
    onBlockedUnlock,
    open,
    previewFile,
    requestCollaboration,
    reportPendingCompatibility,
    reportUnsupportedEditAttempt,
    state.status,
  ]);

  const handleLockedEditAttempt = useCallback(() => {
    if (isUnlocked) {
      return;
    }
    flashUnlockControl();
    onReadonlyEditAttempt?.();
  }, [flashUnlockControl, isUnlocked, onReadonlyEditAttempt]);

  const handleToggleLock = useCallback(() => {
    if (!isUnlocked) {
      handleUnlock();
      return;
    }
    void handleFinalize();
  }, [handleFinalize, handleUnlock, isUnlocked]);

  useEffect(() => {
    const actionsMap = actionsMapRef?.current;
    const actions: DocxBrowserEditorActions = {
      cancel: handleCancel,
      finalize: () => {
        if (state.status === "editing") {
          void handleFinalize();
        }
      },
      flushPendingChanges,
      print: () => {
        editorRef.current?.print();
      },
      unlock: () => {
        void requestEditMode();
      },
    };

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
      if (actionsMap && actionsKey && actionsMap.get(actionsKey) === actions) {
        actionsMap.delete(actionsKey);
      }
    };
  }, [
    actionsKey,
    actionsMapRef,
    actionsRef,
    flushPendingChanges,
    handleCancel,
    handleFinalize,
    requestEditMode,
    state.status,
  ]);

  // Hold the last editing buffer so the editor doesn't swap to the
  // preview buffer during the save transition (`state` becomes
  // "saving" with no buffer of its own). Without this we'd reload the
  // editor against `previewFile.buffer` for the few hundred ms before
  // the parent unmounts us — and the Stella fallback would flash.
  const preservedLoadedBuffer =
    preservedLoadedBufferRef.current?.fieldId === fieldId
      ? preservedLoadedBufferRef.current.buffer
      : null;
  const collaborationSeedBuffer =
    collaborationSession?.seedDocumentBuffer ?? null;
  const editorBuffer = selectDocxBrowserEditorBuffer({
    collaborationSeedBuffer,
    isCollaborativeEditing,
    lastEditingBuffer: lastEditingBufferRef.current,
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

  const showLockLabel = isUnlocked || isPromptingUnlock;
  const lockActionLabel = isUnlocked
    ? t("folio.finishEditing")
    : t("folio.editFile");

  const toolbarExtra = (() => {
    if (showActionBar || actionBarControls !== undefined) {
      return (
        <>
          {actionBarControls}
          {showActionBar && (
            <>
              <Tooltip
                content={lockActionLabel}
                render={
                  <Button
                    aria-label={lockActionLabel}
                    className={cn(
                      "transition-all",
                      showLockLabel ? "px-2" : "",
                      isPromptingUnlock &&
                        "bg-primary/10 text-primary ring-primary/60 animate-pulse ring-2",
                    )}
                    disabled={
                      state.status === "opening" ||
                      state.status === "saving" ||
                      collaborationState.status === "opening"
                    }
                    onClick={handleToggleLock}
                    size={showLockLabel ? "sm" : "icon-sm"}
                    variant="ghost"
                  >
                    {isUnlocked ? <LockOpenIcon /> : <LockIcon />}
                    {showLockLabel && <span>{lockActionLabel}</span>}
                  </Button>
                }
              />
              {isUnlocked && <AutosaveIndicator status={autosaveStatus} />}
            </>
          )}
        </>
      );
    }
    return undefined;
  })();

  useEffect(() => {
    if (!isUnlocked) {
      setEditorMode("editing");
    }
  }, [isUnlocked]);

  useLayoutEffect(() => {
    const styleLabelElement = containerRef.current?.querySelector<HTMLElement>(
      '[data-folio-style-picker] [data-slot="select-value"]',
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
          state.detail ?? t(editSessionErrorDescriptionKey(state.reason))
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

  if (previewFile === null || editorBuffer === undefined) {
    return (
      <DocxEditorLoadingFallback
        label={t("folio.loadingDocument")}
        scaleOffset={scaleOffset}
        showActionBar={showActionBar}
        stylePickerLabel={lastStyleLabelRef.current}
        stylePickerLabelStyle={lastStyleLabelStyleRef.current}
        toolbarExtra={toolbarExtra}
        zoom={targetZoom}
      />
    );
  }

  const previewIdentity = previewFile.fileId;
  const collaborationIdentity = collaborationSession?.sessionId ?? "local";

  return (
    <div ref={containerRef} className="flex h-full w-full min-w-0 flex-col">
      {/* Folio editor with AI overlay */}
      <div
        className="min-w-0 flex-1 overflow-hidden"
        onDoubleClickCapture={isUnlocked ? undefined : handleLockedEditAttempt}
      >
        <FileViewerWithAI
          key={`ai-${previewIdentity}`}
          activeFile={{
            editable: canUnlock,
            entityId,
            fileFieldId: fieldId,
            fileName: previewFile.fileName,
          }}
          docxEditable={isUnlocked}
          docxEditorRef={editorRef}
          requestDocxEditMode={requestEditMode}
          workspaceId={workspaceId}
        >
          <Suspense
            fallback={
              <DocxEditorLoadingFallback
                label={t("folio.loadingEditor")}
                scaleOffset={scaleOffset}
                showActionBar={showActionBar}
                stylePickerLabel={lastStyleLabelRef.current}
                stylePickerLabelStyle={lastStyleLabelStyleRef.current}
                toolbarExtra={toolbarExtra}
                zoom={targetZoom}
              />
            }
          >
            <DocxEditor
              key={`docx-${previewIdentity}-${collaborationIdentity}`}
              ref={editorRef}
              autoOpenReviewSidebar={false}
              className="folio-docx-preview folio-peek h-full"
              documentBuffer={editorBuffer}
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
              {...(onScrollTopChange !== undefined
                ? { onScrollTopChange }
                : {})}
              loadingIndicator={
                <DocxEditorLoadingFallback
                  label={t("folio.loadingDocument")}
                  scaleOffset={scaleOffset}
                  showActionBar={showActionBar}
                  stylePickerLabel={lastStyleLabelRef.current}
                  stylePickerLabelStyle={lastStyleLabelStyleRef.current}
                  toolbarExtra={toolbarExtra}
                  zoom={targetZoom}
                />
              }
              preserveDocumentWhileLoading
            />
          </Suspense>
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
  useEffect(() => {
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
      title={isSynced ? t("folio.synced") : t("folio.syncing")}
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
  const lockActionLabel = t("folio.editFile");
  const toolbarExtra =
    showActionBar || actionBarControls !== undefined ? (
      <>
        {actionBarControls}
        {showActionBar && (
          <Tooltip
            content={lockActionLabel}
            render={
              <Button
                aria-label={lockActionLabel}
                disabled
                size="icon-sm"
                variant="ghost"
              >
                <LockIcon />
              </Button>
            }
          />
        )}
      </>
    ) : undefined;

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
