import { use, useCallback, useMemo, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { ReviewBar } from "@/components/ai-suggestions/review-bar";
import { compileCreateDocumentSourceToDocument } from "@/components/chat/create-document-compiler";
import { attachCreateDocumentDraftEditor } from "@/components/chat/create-document-draft-inspector-editor.logic";
import {
  bindCreateDocumentDraftChatThread as retainCreateDocumentDraftChatThread,
  clearCreateDocumentDraftChatThreadBinding,
  getCreateDocumentDraftRestoration,
} from "@/components/chat/create-document-draft-runtime";
import {
  buildCreateDocumentDownloadFileName,
  createDocumentDraftReviewId,
  type CreateDocumentDraftPayload,
  getCreateDocumentDraftEditorAccess,
  resolveCreateDocumentDraftOverlayChatThreadId,
} from "@/components/chat/create-document-draft.logic";
import {
  DocxEditor,
  type DocxEditorRef,
} from "@/components/docx/app-docx-editor";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  bindCreateDocumentDraftInspectorChatThread,
  setCreateDocumentDraftInspectorChatThreadId,
} from "@/features/chat/hooks/use-chat-session-created-document.logic";
import { fileOptions } from "@/lib/files/queries";

type CreateDocumentDraftInspectorEditorProps = {
  payload: CreateDocumentDraftPayload;
};

export const CreateDocumentDraftInspectorEditor = ({
  payload,
}: CreateDocumentDraftInspectorEditorProps) => {
  const t = useTranslations();
  const editorRef = useRef<DocxEditorRef>(null);
  const persistedFileQuery = useQuery({
    ...fileOptions({
      workspaceId: payload.status === "persisted" ? payload.workspaceId : "",
      fieldId: payload.status === "persisted" ? payload.fieldId : "",
      purpose: "native-display",
    }),
    enabled: payload.status === "persisted",
  });
  const compiled = useMemo(
    () =>
      payload.source.trim()
        ? compileCreateDocumentSourceToDocument(payload.source, {
            titleFallback: payload.name || "Draft",
          })
        : null,
    [payload.name, payload.source],
  );
  const compiledDocument = compiled?.status === "ok" ? compiled.document : null;
  const availableRestoration = getCreateDocumentDraftRestoration(
    payload.toolCallId,
  );
  const [restoration] = useState(availableRestoration);
  const restoredDraft = restoration === null ? null : use(restoration);
  const restoredBuffer =
    restoredDraft?.status === "saved" ? restoredDraft.buffer : null;
  const draftEditable =
    getCreateDocumentDraftEditorAccess(payload) === "editable";

  const attachEditor = useCallback(
    (editor: DocxEditorRef | null) => {
      if (editor === null) {
        return undefined;
      }
      if (!draftEditable) {
        editorRef.current = editor;
        return () => {
          if (editorRef.current === editor) {
            editorRef.current = null;
          }
        };
      }
      return attachCreateDocumentDraftEditor({
        editor,
        editorRef,
        toolCallId: payload.toolCallId,
      });
    },
    [draftEditable, payload.toolCallId],
  );
  const handleChatThreadIdChange = useCallback(
    (chatThreadId: CreateDocumentDraftPayload["chatThreadId"]) => {
      const changed = setCreateDocumentDraftInspectorChatThreadId({
        chatThreadId,
        inspector: useInspectorTabsStore.getState(),
        toolCallId: payload.toolCallId,
      });
      if (changed && chatThreadId !== payload.chatThreadId) {
        clearCreateDocumentDraftChatThreadBinding(payload.toolCallId);
      }
    },
    [payload.chatThreadId, payload.toolCallId],
  );
  const handleActiveDraftChatBound = useCallback(
    (chatThreadId: CreateDocumentDraftPayload["chatThreadId"]) => {
      bindCreateDocumentDraftInspectorChatThread({
        chatThreadId,
        inspector: useInspectorTabsStore.getState(),
        toolCallId: payload.toolCallId,
      });
      retainCreateDocumentDraftChatThread({
        chatThreadId,
        toolCallId: payload.toolCallId,
      });
    },
    [payload.toolCallId],
  );

  if (persistedFileQuery.error) {
    throw persistedFileQuery.error;
  }

  if (restoredDraft?.status === "failed") {
    return (
      <div
        className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm"
        role="alert"
      >
        {t("chat.createDocument.failedHeader")}
      </div>
    );
  }

  if (payload.status === "persisted" && persistedFileQuery.data === undefined) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
        {t("common.loading")}
      </div>
    );
  }

  if (payload.status !== "persisted" && compiled?.status !== "ok") {
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
        document={
          payload.status === "persisted" || restoredBuffer !== null
            ? null
            : compiledDocument
        }
        documentBuffer={
          payload.status === "persisted"
            ? (persistedFileQuery.data?.buffer ?? null)
            : restoredBuffer
        }
        documentKey={
          payload.status === "persisted" ? payload.fieldId : payload.toolCallId
        }
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
      chatThreadId={resolveCreateDocumentDraftOverlayChatThreadId(payload)}
      docxEditable={draftEditable}
      docxEditorRef={editorRef}
      onChatThreadIdChange={handleChatThreadIdChange}
      onActiveDraftChatBound={handleActiveDraftChatBound}
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
