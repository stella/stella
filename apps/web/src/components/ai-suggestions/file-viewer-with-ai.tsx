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

import type { ReactNode } from "react";

import { cn } from "@stll/ui/lib/utils";

import { FileChatOverlay } from "./file-chat-overlay";
import "./file-viewer-with-ai.css";

type ActiveFile = {
  entityId: string;
  editable?: boolean | undefined;
  fileName: string;
};

type FileViewerWithAIProps = {
  /**
   * Workspace this file belongs to. Used to scope the chat
   * thread + `@`-mention sources.
   */
  workspaceId: string;
  /**
   * Stable identifier for this file's chat thread. Use the file's
   * entity id (or any per-file unique string) so drafts + history
   * persist across mounts and stay isolated from other files'
   * chats.
   */
  chatThreadId: string;
  /**
   * Optional file context surfaced to the model so prompts can
   * reference "the file you're looking at" — entity id and human
   * filename. Improves the AI's grounding when both are available.
   */
  activeFile?: ActiveFile | undefined;
  /** Optional class name applied to the wrapper. */
  className?: string;
  /** The actual file viewer component. */
  children: ReactNode;
};

export function FileViewerWithAI({
  workspaceId,
  chatThreadId,
  activeFile,
  className,
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
        chatThreadId={chatThreadId}
        workspaceId={workspaceId}
      />
    </div>
  );
}
