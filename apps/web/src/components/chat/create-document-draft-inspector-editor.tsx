import { use, useCallback, useMemo, useRef, useState } from "react";

import { useTranslations } from "use-intl";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { ReviewBar } from "@/components/ai-suggestions/review-bar";
import { compileCreateDocumentSourceToDocument } from "@/components/chat/create-document-compiler";
import { attachCreateDocumentDraftEditor } from "@/components/chat/create-document-draft-inspector-editor.logic";
import { getCreateDocumentDraftRestoration } from "@/components/chat/create-document-draft-runtime";
import {
  buildCreateDocumentDownloadFileName,
  createDocumentDraftReviewId,
  type CreateDocumentDraftPayload,
  getCreateDocumentDraftEditorAccess,
} from "@/components/chat/create-document-draft.logic";
import {
  DocxEditor,
  type DocxEditorRef,
} from "@/components/docx/app-docx-editor";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { setCreateDocumentDraftInspectorChatThreadId } from "@/features/chat/hooks/use-chat-session-created-document.logic";

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
  const availableRestoration = getCreateDocumentDraftRestoration(
    payload.toolCallId,
  );
  const [restoration] = useState(availableRestoration);
  const restoredBuffer = restoration === null ? null : use(restoration);
  const draftEditable =
    getCreateDocumentDraftEditorAccess(payload) === "editable";

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
  const handleChatThreadIdChange = useCallback(
    (chatThreadId: CreateDocumentDraftPayload["chatThreadId"]) => {
      setCreateDocumentDraftInspectorChatThreadId({
        chatThreadId,
        inspector: useInspectorTabsStore.getState(),
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
        document={restoredBuffer === null ? compiled.document : null}
        documentBuffer={restoredBuffer}
        documentKey={payload.toolCallId}
        initialZoom="fit-width"
        loadingIndicator={null}
        mode={draftEditable ? "editing" : "viewing"}
        readOnly={!draftEditable}
        showToolbar={draftEditable}
        showZoomControl={payload.status !== "streaming"}
      />
    </div>
  );

  if (payload.status === "streaming") {
    return editor;
  }

  return (
    <FileViewerWithAI
      className="min-h-0 flex-1"
      activeDraft={
        payload.status === "persisted"
          ? undefined
          : {
              fileName: buildCreateDocumentDownloadFileName(payload.name),
              originChatMessageId: payload.originChatMessageId,
              originChatThreadId: payload.originChatThreadId,
              toolCallId: payload.toolCallId,
            }
      }
      activeFile={
        payload.status === "persisted"
          ? {
              editable: false,
              entityId: payload.entityId,
              fileFieldId: payload.fieldId,
              fileName: payload.fileName,
            }
          : undefined
      }
      chatThreadId={payload.chatThreadId}
      docxEditable={draftEditable}
      docxEditorRef={editorRef}
      onChatThreadIdChange={handleChatThreadIdChange}
      workspaceId={payload.workspaceId}
    >
      {editor}
      {payload.status !== "persisted" && (
        <ReviewBar
          docxEditable={draftEditable}
          docxEditorRef={editorRef}
          entityId={createDocumentDraftReviewId(payload.toolCallId)}
          persistence={{ type: "local" }}
        />
      )}
    </FileViewerWithAI>
  );
};
