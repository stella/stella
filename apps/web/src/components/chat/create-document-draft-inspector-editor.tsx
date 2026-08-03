import { useCallback, useMemo, useRef } from "react";

import { useTranslations } from "use-intl";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { ReviewBar } from "@/components/ai-suggestions/review-bar";
import { compileCreateDocumentSourceToDocument } from "@/components/chat/create-document-compiler";
import { attachCreateDocumentDraftEditor } from "@/components/chat/create-document-draft-inspector-editor.logic";
import {
  buildCreateDocumentDownloadFileName,
  createDocumentDraftReviewId,
  type CreateDocumentDraftPayload,
} from "@/components/chat/create-document-draft.logic";
import {
  DocxEditor,
  type DocxEditorRef,
} from "@/components/docx/app-docx-editor";

type CreateDocumentDraftInspectorEditorProps = {
  payload: CreateDocumentDraftPayload;
};

export const CreateDocumentDraftInspectorEditor = ({
  payload,
}: CreateDocumentDraftInspectorEditorProps) => {
  const t = useTranslations();
  const editorRef = useRef<DocxEditorRef>(null);
  const compiled = useMemo(
    () =>
      payload.source.trim()
        ? compileCreateDocumentSourceToDocument(payload.source, {
            titleFallback: payload.name || "Draft",
          })
        : null,
    [payload.name, payload.source],
  );

  const attachEditor = useCallback(
    (editor: DocxEditorRef | null) => {
      if (editor === null) {
        return undefined;
      }
      return attachCreateDocumentDraftEditor({
        editor,
        editorRef,
        toolCallId: payload.toolCallId,
      });
    },
    [payload.toolCallId],
  );

  if (compiled?.status !== "ok") {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
        {payload.status === "streaming"
          ? t("chat.createDocument.headerStreaming")
          : t("chat.createDocument.previewWaiting")}
      </div>
    );
  }

  const editor = (
    <div className="h-full min-h-0 overflow-auto">
      <DocxEditor
        ref={attachEditor}
        autoOpenReviewSidebar={false}
        className="folio-docx-preview folio-peek h-full"
        document={compiled.document}
        documentKey={payload.toolCallId}
        initialZoom="fit-width"
        loadingIndicator={null}
        mode={payload.status === "ready" ? "editing" : "viewing"}
        readOnly={payload.status === "streaming"}
        showToolbar={payload.status === "ready"}
        showZoomControl={payload.status === "ready"}
      />
    </div>
  );

  if (payload.status === "streaming") {
    return editor;
  }

  return (
    <FileViewerWithAI
      activeDraft={{
        fileName: buildCreateDocumentDownloadFileName(payload.name),
        originChatMessageId: payload.originChatMessageId,
        originChatThreadId: payload.originChatThreadId,
        toolCallId: payload.toolCallId,
      }}
      chatThreadId={payload.chatThreadId}
      docxEditable
      docxEditorRef={editorRef}
      workspaceId={payload.workspaceId}
    >
      {editor}
      <ReviewBar
        docxEditable
        docxEditorRef={editorRef}
        entityId={createDocumentDraftReviewId(payload.toolCallId)}
        persistence={{ type: "local" }}
      />
    </FileViewerWithAI>
  );
};
