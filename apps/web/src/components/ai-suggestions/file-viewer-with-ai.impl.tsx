/**
 * FileViewerWithAI
 *
 * Layout-agnostic wrapper that mounts the AI chat overlay on top of
 * any file viewer (DOCX, PDF, future viewers). Wrap the actual
 * viewer in this and the AI surface is positioned over it.
 *
 * The chat overlay (`FileChatOverlay`) talks to the same `/chat`
 * endpoint as the inspector chat tab — same persistence, same
 * `@`-mention sources, same streaming model. Suggestion accept/
 * reject UI is not wired here yet; that's Phase E (model proposes
 * edits via a `propose-suggestion` tool, frontend renders accept
 * cards).
 */

import type { ReactNode, RefObject } from "react";
import { startTransition, useRef } from "react";

import {
  setAISuggestionsMeta,
  setFocusedSuggestionMeta,
} from "@stll/folio-react";
import type { DocxEditorRef } from "@stll/folio-react";

import {
  getCreateDocumentDraftPersistence,
  type CreateDocumentDraftPersistence,
} from "@/components/chat/create-document-draft-runtime";
import type { DocxComments } from "@/components/docx/app-docx-editor";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { DocxEditSafety } from "@/lib/chat-edit-mode";
import { createChatThreadId, type ChatThreadId } from "@/lib/chat-thread-ref";

import type { FileChatOverlayActivation } from "./file-viewer-with-ai-config";
import { FileChatOverlay } from "./file-chat-overlay";
import { resolveFileReviewSessionId } from "./file-review-session";
import {
  buildFolioReviewDecorations,
  resolveFolioReviewFocusId,
} from "./review-folio-decorations";
import { useReviewStore } from "./review-store";
import type { ReviewSuggestion } from "./review-store";
import { stageReviewSuggestions } from "./review-suggestion-staging";
import "./file-viewer-with-ai.css";

type ActiveFile = {
  entityId: string;
  editable?: boolean | undefined;
  fileFieldId?: string | undefined;
  fileName: string;
};

type ActiveExternal = {
  connectorSlug?: string | undefined;
  provider?: string | undefined;
  snippet?: string | undefined;
  sourceToolName?: string | undefined;
  text?: string | undefined;
  title: string;
  url: string;
};

export type ActiveDocumentDraft = {
  fileName: string;
  originChatMessageId: string;
  originChatThreadId: ChatThreadId;
  toolCallId: string;
};

export type FileViewerWithAIProps = {
  /**
   * Controls whether the lazy overlay is mounted without changing the viewer root.
   */
  overlayActivation?: FileChatOverlayActivation;
  /**
   * Workspace this viewer belongs to. Used to scope the chat
   * thread + `@`-mention sources when present.
   */
  workspaceId?: string | undefined;
  /**
   * Explicit thread id for previews that do not resolve through
   * the workspace file-chat mapping.
   */
  chatThreadId?: ChatThreadId | undefined;
  /** Persist an explicit thread rotation in the viewer's owning surface. */
  onChatThreadIdChange?: ((threadId: ChatThreadId) => void) | undefined;
  /** The server has persisted this draft chat's active-draft binding. */
  onActiveDraftChatBound?: ((threadId: ChatThreadId) => void) | undefined;
  /**
   * Optional file context surfaced to the model so prompts can
   * reference "the file you're looking at" — entity id and human
   * filename. Improves the AI's grounding when both are available.
   */
  activeFile?: ActiveFile | undefined;
  /** Unsaved generated DOCX currently visible in this viewer. */
  activeDraft?: ActiveDocumentDraft | undefined;
  /** Optional external source context, for MCP/web previews. */
  activeExternal?: ActiveExternal | undefined;
  /** Optional class name applied to the wrapper. */
  className?: string;
  /** Live Folio editor ref used by the overlay's DOCX edit tool. */
  docxEditorRef?: RefObject<DocxEditorRef | null> | undefined;
  /**
   * The host's controlled `DocxEditor` `comments` state and its setter,
   * forwarded to the overlay's folio-agents comment tools (read/add/reply/
   * resolve). Omit on viewers that do not wire the comment round-trip.
   */
  docxComments?: DocxComments | undefined;
  onDocxCommentsChange?: ((comments: DocxComments) => void) | undefined;
  /** Whether the current DOCX session may accept AI edit operations. */
  docxEditable?: boolean | undefined;
  /**
   * DOCX rewrite-safety. `unsafe` blocks editing (shown quietly as a
   * "View only" edit-mode chip instead of a toast); `checking` (probe
   * pending) also withholds the AI edit tool until the result lands.
   */
  docxEditSafety?: DocxEditSafety | undefined;
  /** Request editable DOCX mode before applying a confirmed AI edit. */
  requestDocxEditMode?: (() => boolean | Promise<boolean>) | undefined;
  /** The actual file viewer component. */
  children: ReactNode;
};

type FileChatOverlayHostProps = Omit<
  FileViewerWithAIProps,
  "children" | "className" | "onChatThreadIdChange" | "overlayActivation"
> & {
  onChatThreadIdChange: (threadId: ChatThreadId) => void;
};

type ResolveActiveReviewSessionIdOptions = {
  activeDraft: ActiveDocumentDraft | undefined;
  activeFile: ActiveFile | undefined;
};

const resolveActiveReviewSessionId = ({
  activeDraft,
  activeFile,
}: ResolveActiveReviewSessionIdOptions): string | undefined => {
  if (activeFile !== undefined) {
    return resolveFileReviewSessionId({
      type: "file",
      entityId: activeFile.entityId,
    });
  }
  if (activeDraft !== undefined) {
    return resolveFileReviewSessionId({
      type: "draft",
      toolCallId: activeDraft.toolCallId,
    });
  }
  return resolveFileReviewSessionId({ type: "none" });
};

const EMPTY_REVIEW_SUGGESTIONS: readonly ReviewSuggestion[] = [];

const ReviewFolioDecorationsBridge = ({
  docxEditorRef,
  docxEditable,
  entityId,
}: {
  docxEditorRef: RefObject<DocxEditorRef | null>;
  docxEditable: boolean;
  entityId: string;
}) => {
  const managedSuggestionIdsRef = useRef(new Set<string>());
  const suggestions = useReviewStore(
    (state) => state.sessions[entityId] ?? EMPTY_REVIEW_SUGGESTIONS,
  );
  const focusedId = useReviewStore(
    (state) => state.focusedId[entityId] ?? null,
  );

  useExternalSyncEffect(() => {
    let animationFrame: number | null = null;
    let cancelled = false;
    const sync = () => {
      if (cancelled) {
        return;
      }
      const editor = docxEditorRef.current;
      if (editor === null) {
        animationFrame = requestAnimationFrame(sync);
        return;
      }
      editor.ensureEditorView({ focus: false });
      const view = editor.getEditorRef()?.getView();
      if (!view) {
        animationFrame = requestAnimationFrame(sync);
        return;
      }
      stageReviewSuggestions({
        canStage: docxEditable,
        editor,
        managedSuggestionIds: managedSuggestionIdsRef.current,
        suggestions,
        updateSuggestion: (id, patch) => {
          useReviewStore.getState().updateSuggestion(entityId, id, patch);
        },
      });
      const nativeSuggestionIds = new Set(
        editor.getSuggestions().map((suggestion) => suggestion.suggestionId),
      );
      const folioSuggestions = buildFolioReviewDecorations(
        suggestions.filter(
          (suggestion) =>
            suggestion.pendingOperation === null ||
            !nativeSuggestionIds.has(suggestion.pendingOperation.id),
        ),
        view.state.doc,
      );
      const suggestionsMeta = setAISuggestionsMeta(folioSuggestions);
      view.dispatch(
        view.state.tr.setMeta(suggestionsMeta.key, suggestionsMeta.payload),
      );
      const focusedMeta = setFocusedSuggestionMeta(
        resolveFolioReviewFocusId({
          focusedId,
          nativeSuggestionIds,
          suggestions,
        }),
      );
      view.dispatch(
        view.state.tr.setMeta(focusedMeta.key, focusedMeta.payload),
      );
    };
    sync();
    return () => {
      cancelled = true;
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, [docxEditable, docxEditorRef, entityId, focusedId, suggestions]);

  return null;
};

export const FileChatOverlayHost = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeDraft,
  activeExternal,
  docxEditable,
  docxEditSafety,
  docxEditorRef,
  docxComments,
  onDocxCommentsChange,
  onChatThreadIdChange,
  onActiveDraftChatBound,
  requestDocxEditMode,
}: FileChatOverlayHostProps) => {
  const draftPersistence: CreateDocumentDraftPersistence =
    activeDraft === undefined
      ? { status: "idle" }
      : getCreateDocumentDraftPersistence(activeDraft.toolCallId);
  const handleNewThread = () => {
    // The current runtime state is read again at the interaction boundary.
    // This closes the small interval before React commits the saving payload:
    // a click cannot rotate the thread after the save captured its binding.
    if (
      activeDraft !== undefined &&
      getCreateDocumentDraftPersistence(activeDraft.toolCallId).status ===
        "saving"
    ) {
      return;
    }
    // The previous thread's queued/accepted/rejected suggestions
    // belong to that thread's history. Carrying them into a fresh
    // thread invites the user to act on proposals they no longer
    // have context for; reset the session whenever they explicitly
    // start a new chat.
    const reviewSessionId = resolveActiveReviewSessionId({
      activeDraft,
      activeFile,
    });
    if (reviewSessionId !== undefined) {
      useReviewStore.getState().resetSession(reviewSessionId);
    }
    // Wrap the swap in a transition so React keeps the current chat
    // visible while `chatThreadOptions` suspends on the new key,
    // instead of unmounting back to the Suspense spinner. The fresh
    // thread snaps in atomically once its (empty) state is ready.
    startTransition(() => {
      onChatThreadIdChange(createChatThreadId());
    });
  };

  const reviewSessionId = resolveActiveReviewSessionId({
    activeDraft,
    activeFile,
  });

  return (
    <>
      {docxEditorRef !== undefined && reviewSessionId !== undefined && (
        <ReviewFolioDecorationsBridge
          docxEditorRef={docxEditorRef}
          docxEditable={docxEditable === true}
          entityId={reviewSessionId}
        />
      )}
      <FileChatOverlay
        activeExternal={activeExternal}
        activeDraft={activeDraft}
        activeFile={activeFile}
        chatThreadId={chatThreadId}
        draftPersistence={draftPersistence}
        docxComments={docxComments}
        docxEditable={docxEditable}
        docxEditSafety={docxEditSafety}
        docxEditorRef={docxEditorRef}
        onDocxCommentsChange={onDocxCommentsChange}
        onActiveDraftChatBound={onActiveDraftChatBound}
        onNewThread={handleNewThread}
        requestDocxEditMode={requestDocxEditMode}
        workspaceId={workspaceId}
      />
    </>
  );
};
