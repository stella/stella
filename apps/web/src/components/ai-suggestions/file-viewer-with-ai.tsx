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

import type { DocxEditorRef } from "@stll/folio";
import { cn } from "@stll/ui/lib/utils";

import type { ChatThreadId } from "@/lib/chat-thread-ref";

import { FileChatOverlay } from "./file-chat-overlay";
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

type FileViewerWithAIProps = {
  /**
   * Workspace this viewer belongs to. Used to scope the chat
   * thread + `@`-mention sources when present.
   */
  workspaceId?: string | undefined;
  /**
   * Stable identifier for this file's chat thread. Use the file's
   * entity id (or any per-file unique string) so drafts + history
   * persist across mounts and stay isolated from other files'
   * chats.
   */
  chatThreadId: ChatThreadId;
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

export function FileViewerWithAI({
  workspaceId,
  chatThreadId,
  activeFile,
  activeExternal,
  className,
  docxEditable,
  docxEditorRef,
  requestDocxEditMode,
  children,
}: FileViewerWithAIProps) {
  return (
    <div
      data-file-viewer-ai="true"
      className={cn("relative h-full w-full", className)}
    >
      {children}
      <FileChatOverlay
        activeFile={activeFile}
        activeExternal={activeExternal}
        chatThreadId={chatThreadId}
        docxEditable={docxEditable}
        docxEditorRef={docxEditorRef}
        requestDocxEditMode={requestDocxEditMode}
        workspaceId={workspaceId}
      />
    </div>
  );
}
