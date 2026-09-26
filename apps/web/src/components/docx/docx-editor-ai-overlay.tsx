import type { ReactNode, RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { ReviewBar } from "@/components/ai-suggestions/review-bar";
import type { DocxComments } from "@/components/docx/app-docx-editor";

import {
  getDocxEditBlockReason,
  getDocxEditSafety,
} from "./docx-browser-editor.logic";
import type { DocxEditModeResult } from "./docx-browser-editor.logic";

type DocxEditorAiOverlayProps = {
  canSafelyEdit: boolean | undefined;
  canUnlock: boolean;
  /** The editor the overlay's AI tools and review stepper act on. */
  children: ReactNode;
  docxComments: DocxComments;
  editorRef: RefObject<DocxEditorRef | null>;
  entityId: string;
  fieldId: string;
  fileName: string;
  isUnlocked: boolean;
  onDocxCommentsChange: (comments: DocxComments) => void;
  requestEditMode: () => Promise<DocxEditModeResult>;
  workspaceId: string;
};

/** The file-chat overlay and the AI review stepper around the editor. */
export const DocxEditorAiOverlay = ({
  canSafelyEdit,
  canUnlock,
  children,
  docxComments,
  editorRef,
  entityId,
  fieldId,
  fileName,
  isUnlocked,
  onDocxCommentsChange,
  requestEditMode,
  workspaceId,
}: DocxEditorAiOverlayProps) => (
  <FileViewerWithAI
    activeFile={{
      editable: canUnlock,
      entityId,
      fileFieldId: fieldId,
      fileName,
    }}
    docxComments={docxComments}
    docxEditable={isUnlocked}
    docxEditSafety={getDocxEditSafety({ canSafelyEdit })}
    docxEditorRef={editorRef}
    onDocxCommentsChange={onDocxCommentsChange}
    requestDocxEditMode={requestEditMode}
    workspaceId={workspaceId}
  >
    {children}
    {/* Floating bottom-center review stepper for the AI's pending
        DOCX suggestions. Rendered inside the FileViewerWithAI
        positioned container so it shares the chat composer's
        coordinate space (it clears the composer at `bottom-24`).
        Returns null unless this entity has pending suggestions. */}
    <ReviewBar
      applyBlockReason={getDocxEditBlockReason({ canSafelyEdit })}
      docxEditable={isUnlocked}
      docxEditorRef={editorRef}
      entityId={entityId}
      persistence={{ type: "workspace", workspaceId }}
      requestDocxEditMode={requestEditMode}
    />
  </FileViewerWithAI>
);
