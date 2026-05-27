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
import { startTransition, useState } from "react";

import type { DocxEditorRef } from "@stll/folio";

import type { ChatThreadId } from "@/lib/chat-thread-ref";
import { createChatThreadId } from "@/lib/chat-thread-ref";

import { FileChatOverlay } from "./file-chat-overlay";
import { useReviewStore } from "./review-store";
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

export type FileViewerWithAIProps = {
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
  /**
   * Optional file context surfaced to the model so prompts can
   * reference "the file you're looking at" — entity id and human
   * filename. Improves the AI's grounding when both are available.
   */
  activeFile?: ActiveFile | undefined;
  /** Optional external source context, for MCP/web previews. */
  activeExternal?: ActiveExternal | undefined;
  /** Optional class name applied to the wrapper. */
  className?: string;
  /** Live Folio editor ref used by the overlay's DOCX edit tool. */
  docxEditorRef?: RefObject<DocxEditorRef | null> | undefined;
  /** Whether the current DOCX session may accept AI edit operations. */
  docxEditable?: boolean | undefined;
  /** Request editable DOCX mode before applying a confirmed AI edit. */
  requestDocxEditMode?: (() => boolean | Promise<boolean>) | undefined;
  /** The actual file viewer component. */
  children: ReactNode;
};

type FileChatOverlayHostProps = Omit<
  FileViewerWithAIProps,
  "children" | "className"
>;

export const FileChatOverlayHost = ({
  workspaceId,
  chatThreadId: initialChatThreadId,
  activeFile,
  activeExternal,
  docxEditable,
  docxEditorRef,
  requestDocxEditMode,
}: FileChatOverlayHostProps) => {
  const [currentChatThreadId, setCurrentChatThreadId] =
    useState(initialChatThreadId);

  const handleNewThread = () => {
    // The previous thread's queued/accepted/rejected suggestions
    // belong to that thread's history. Carrying them into a fresh
    // thread invites the user to act on proposals they no longer
    // have context for; reset the session whenever they explicitly
    // start a new chat.
    if (activeFile) {
      useReviewStore.getState().resetSession(activeFile.entityId);
    }
    // Wrap the swap in a transition so React keeps the current chat
    // visible while `chatThreadOptions` suspends on the new key,
    // instead of unmounting back to the Suspense spinner. The fresh
    // thread snaps in atomically once its (empty) state is ready.
    startTransition(() => {
      setCurrentChatThreadId(createChatThreadId());
    });
  };

  return (
    <FileChatOverlay
      activeExternal={activeExternal}
      activeFile={activeFile}
      chatThreadId={currentChatThreadId}
      docxEditable={docxEditable}
      docxEditorRef={docxEditorRef}
      onNewThread={handleNewThread}
      requestDocxEditMode={requestDocxEditMode}
      workspaceId={workspaceId}
    />
  );
};
