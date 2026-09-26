import { lazy, Suspense } from "react";

import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { FileChatWarmup } from "@/components/ai-suggestions/file-chat-warmup";
import { DocxEditorSlot } from "@/components/docx/docx-editor-host";
import { DOCX_EDITOR_SLOT } from "@/components/docx/docx-editor-host.logic";
import { DocumentAiSourceBar } from "@/components/inspector/document-ai-source-bar";
import { EmailFileViewer } from "@/components/inspector/email-html-viewer";
import {
  EMAIL_CHAT_HOST,
  EMAIL_CHAT_MODE,
} from "@/components/inspector/email-html-viewer.logic";
import type { FileTabDisplayState } from "@/components/inspector/file-tab-panel.logic";
import { InspectorPdfErrorFallback } from "@/components/inspector/inspector-pdf-error-fallback";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { MarkdownFileViewer } from "@/components/inspector/markdown-file-viewer";
import type { DesktopOpenTarget } from "@/components/inspector/use-desktop-file-open";
import type { DocxEditorBindings } from "@/components/inspector/use-docx-editor-bindings";
import type { EmailAttachmentSelection } from "@/components/inspector/use-email-attachment-selection";
import type { FileTabEntity } from "@/components/inspector/use-file-tab-entity";
import type { MarkdownFileDraft } from "@/components/inspector/use-markdown-file-draft";
import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";
import {
  PeekPdfControls,
  PeekPdfViewer,
  PeekSuspenseFallback,
} from "@/components/pdf/peek/peek-pdf-viewer";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { PDF_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import type { PDFColorMode } from "@/lib/pdf/pdf-color-mode";

const OfficeFileViewer = lazy(async () => {
  const m = await import("@/components/office/office-file-viewer");
  return { default: m.OfficeFileViewer };
});

type GetPeekPDFColorControlOptions = {
  colorMode: PDFColorMode;
  mimeType: string | null | undefined;
  onColorModeChange: (colorMode: PDFColorMode) => void;
};

const getPeekPDFColorControl = ({
  colorMode,
  mimeType,
  onColorModeChange,
}: GetPeekPDFColorControlOptions) => {
  if (mimeType !== PDF_MIME) {
    return undefined;
  }
  return { colorMode, onColorModeChange };
};

const viewerErrorFallback = ({ reset }: { reset: () => void }) => (
  <InspectorPdfErrorFallback onRetry={reset} />
);

type FileTabViewerProps = {
  canUpdateEntity: boolean;
  closeAll: () => void;
  desktopEditTarget: Pick<DesktopOpenTarget, "fileType" | "propertyId"> | null;
  display: FileTabDisplayState;
  docxEditor: DocxEditorBindings;
  docxInitialScrollTop: number | undefined;
  emailAttachments: EmailAttachmentSelection;
  entity: FileTabEntity;
  handleResetZoom: (tabId: string) => void;
  handleWheelZoom: (tabId: string, deltaY: number) => void;
  handleZoom: (tabId: string, direction: "in" | "out") => void;
  isEditingNativeDocx: boolean;
  isZoomOverlayVisible: boolean;
  markdown: MarkdownFileDraft;
  onPdfColorModeChange: (colorMode: PDFColorMode) => void;
  onViewerError: () => void;
  pdfColorMode: PDFColorMode;
  peekPdfViewId: string;
  tab: FileTab;
};

/**
 * The file itself, in the viewer its format needs, under the AI source bar
 * when the tab carries a justification.
 */
export const FileTabViewer = ({
  canUpdateEntity,
  closeAll,
  desktopEditTarget,
  display: {
    isActive,
    isEmailDisplay,
    isMarkdownDisplay,
    isNativeDocxDisplay,
    isOfficeDisplay,
    officeViewerFormat,
    scaleOffset,
  },
  docxEditor,
  docxInitialScrollTop,
  emailAttachments: { emailPreviewOverlayActivation, openEmailAttachment },
  entity,
  handleResetZoom,
  handleWheelZoom,
  handleZoom,
  isEditingNativeDocx,
  isZoomOverlayVisible,
  markdown,
  onPdfColorModeChange,
  onViewerError,
  pdfColorMode,
  peekPdfViewId,
  tab,
}: FileTabViewerProps) => {
  const t = useTranslations();
  const pdfColorControl = getPeekPDFColorControl({
    colorMode: pdfColorMode,
    mimeType: tab.mimeType,
    onColorModeChange: onPdfColorModeChange,
  });

  const fileViewer = (() => {
    if (isEmailDisplay) {
      if (entity.shouldSurfaceEmailResolutionError) {
        return (
          <EmailFileViewer
            chatMode={EMAIL_CHAT_MODE.resolutionError}
            entityId={tab.entityId}
            fieldId={tab.id}
            fileName={tab.fileName}
            onOpenAttachment={openEmailAttachment}
            overlayActivation={emailPreviewOverlayActivation}
            onRetryChatResolution={() => {
              detached(entity.query.refetch(), "file-tab-panel.refetch");
            }}
            chatHost={EMAIL_CHAT_HOST.parent}
            workspaceId={tab.workspaceId}
          />
        );
      }
      return (
        <EmailFileViewer
          chatMode={entity.resolvedEmailChatMode}
          entityId={tab.entityId}
          fieldId={tab.id}
          fileName={tab.fileName}
          onOpenAttachment={openEmailAttachment}
          overlayActivation={emailPreviewOverlayActivation}
          chatHost={EMAIL_CHAT_HOST.parent}
          workspaceId={tab.workspaceId}
        />
      );
    }
    if (isMarkdownDisplay) {
      return (
        <MarkdownFileViewer
          draft={markdown}
          readOnly={!canUpdateEntity}
          tabId={tab.id}
        />
      );
    }
    if (isOfficeDisplay && officeViewerFormat !== null) {
      return (
        <QuerySuspenseBoundary
          area="office-file-viewer"
          errorFallback={viewerErrorFallback}
          resetKeys={[tab.id]}
          suspenseFallback={
            <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center text-sm">
              {t("common.loading")}
            </div>
          }
        >
          <OfficeFileViewer
            desktopEditTarget={desktopEditTarget}
            entityId={tab.entityId}
            fieldId={tab.id}
            fileName={tab.fileName}
            format={officeViewerFormat}
            key={tab.id}
            workspaceId={tab.workspaceId}
          />
        </QuerySuspenseBoundary>
      );
    }
    if (isNativeDocxDisplay) {
      if (entity.filePropertyId === undefined) {
        // Still resolving the field's property, or the entity no longer
        // holds this field: never fall through to the PDF viewer, which has
        // nothing to draw for a DOCX.
        return entity.query.data === undefined && !entity.query.isError ? (
          <PeekSuspenseFallback />
        ) : (
          <InspectorPdfErrorFallback />
        );
      }
      return (
        <>
          {/* Beside the slot, not inside the editor: the chat overlay travels
              with the editor's chunk, and its two reads would otherwise queue
              behind that fetch instead of running alongside it. */}
          <FileChatWarmup
            entityId={tab.entityId}
            fileFieldId={tab.id}
            workspaceId={tab.workspaceId}
          />
          <DocxEditorSlot
            bindings={docxEditor.bindings}
            canUnlock={canUpdateEntity}
            document={{
              entityId: tab.entityId,
              fileFieldId: tab.id,
              propertyId: entity.filePropertyId,
              workspaceId: tab.workspaceId,
            }}
            fallback={<PeekSuspenseFallback />}
            initialScrollTop={docxInitialScrollTop}
            isEditing={isEditingNativeDocx}
            scaleOffset={scaleOffset}
            slot={DOCX_EDITOR_SLOT.inspector}
          />
        </>
      );
    }
    return (
      <PeekPdfViewer
        activePropertyId={entity.filePropertyId ?? ""}
        entityId={tab.entityId}
        errorFallback={viewerErrorFallback}
        fieldId={tab.id}
        filePurpose="display"
        colorMode={pdfColorMode}
        mimeType={tab.mimeType ?? undefined}
        onDocxScrollTopChange={docxEditor.handleScrollTopChange}
        onError={onViewerError}
        onPeekNavigate={closeAll}
        onWheelZoom={(deltaY) => handleWheelZoom(tab.id, deltaY)}
        scaleOffset={scaleOffset}
        viewId={peekPdfViewId}
        workspaceId={tab.workspaceId}
      />
    );
  })();

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {tab.justificationFieldId && !isEmailDisplay && !isMarkdownDisplay && (
          <Suspense
            fallback={
              <div
                className={cn(
                  "text-muted-foreground flex items-center border-b px-3 text-xs italic",
                  TOOLBAR_ROW_HEIGHT,
                )}
              >
                {t("common.loading")}...
              </div>
            }
          >
            <DocumentAiSourceBar
              activeTab={tab}
              fieldId={tab.justificationFieldId}
              isActiveTab={isActive}
              workspaceId={tab.workspaceId}
            />
          </Suspense>
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {fileViewer}
          {/* Floating preview-only toolbar mounted on top of the
              viewer body — zoom controls only. The edit-mode exit
              (Save / Create version) lives in the tab header. */}
          {isZoomOverlayVisible ? (
            <ViewerOverlayBar>
              <PeekPdfControls
                onReset={() => handleResetZoom(tab.id)}
                onZoom={(direction) => handleZoom(tab.id, direction)}
                pdfColorControl={pdfColorControl}
                scaleOffset={scaleOffset}
              />
            </ViewerOverlayBar>
          ) : null}
        </div>
      </div>
    </div>
  );
};
