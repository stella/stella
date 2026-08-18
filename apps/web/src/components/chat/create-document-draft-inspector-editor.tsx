import { use, useCallback, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { FILE_CHAT_OVERLAY_ACTIVATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import { ReviewBar } from "@/components/ai-suggestions/review-bar";
import { attachCreateDocumentDraftEditor } from "@/components/chat/create-document-draft-inspector-editor.logic";
import {
  advanceCreateDocumentDraftPreview,
  CREATE_DOCUMENT_DRAFT_STREAM_PREVIEW_INTERVAL_MS,
} from "@/components/chat/create-document-draft-preview.logic";
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
  // The stream delivers the source per token and every accepted revision
  // reloads the editor: coalesce while streaming, apply the final source at once.
  const [throttledSource] = useDebounce(
    payload.source,
    CREATE_DOCUMENT_DRAFT_STREAM_PREVIEW_INTERVAL_MS,
    {
      leading: true,
      maxWait: CREATE_DOCUMENT_DRAFT_STREAM_PREVIEW_INTERVAL_MS,
    },
  );
  const previewInput = {
    name: payload.name,
    source: payload.status === "streaming" ? throttledSource : payload.source,
    status: payload.status,
  };
  // Adjusting state during render: the preview carries the last compiled
  // document across streaming revisions that fail to compile, which needs the
  // previous render's result rather than a pure derivation of the payload.
  const [previewState, setPreviewState] = useState(() =>
    advanceCreateDocumentDraftPreview(null, previewInput),
  );
  const nextPreviewState = advanceCreateDocumentDraftPreview(
    previewState,
    previewInput,
  );
  if (nextPreviewState !== previewState) {
    setPreviewState(nextPreviewState);
  }
  const preview = nextPreviewState.preview;
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

  if (payload.status !== "persisted" && preview === null) {
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
            : (preview?.document ?? null)
        }
        documentBuffer={
          payload.status === "persisted"
            ? (persistedFileQuery.data?.buffer ?? null)
            : restoredBuffer
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

  // The streaming draft renders inside the same viewer shell with the AI
  // overlay deferred, so the editor keeps its tree position (no remount, no
  // fresh parse and layout) when the draft becomes ready.
  return (
    <FileViewerWithAI
      className="min-h-0 flex-1"
      overlayActivation={
        payload.status === "streaming"
          ? FILE_CHAT_OVERLAY_ACTIVATION.deferred
          : FILE_CHAT_OVERLAY_ACTIVATION.active
      }
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
      {(payload.status === "ready" || payload.status === "saving") && (
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
