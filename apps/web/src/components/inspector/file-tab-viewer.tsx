import {
  type ComponentType,
  lazy,
  memo,
  type ReactNode,
  Suspense,
} from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { signatureFormatCandidate } from "@stll/api-contract/document-format";
import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";
import { cn } from "@stll/ui/utils";

import { FileChatWarmup } from "@/components/ai-suggestions/file-chat-warmup";
import { DocxEditorSlot } from "@/components/docx/docx-editor-host";
import { DOCX_EDITOR_SLOT } from "@/components/docx/docx-editor-host.logic";
import { AudioFileViewer } from "@/components/inspector/audio-file-viewer";
import { DocumentAiSourceBar } from "@/components/inspector/document-ai-source-bar";
import { EmailFileViewer } from "@/components/inspector/email-html-viewer";
import {
  EMAIL_CHAT_HOST,
  EMAIL_CHAT_MODE,
} from "@/components/inspector/email-html-viewer.logic";
import { downloadTabFile } from "@/components/inspector/file-download-service";
import type { FileTabDisplayState } from "@/components/inspector/file-tab-panel.logic";
import {
  ConversionRefusalFallback,
  FilePreviewUnavailable,
  InspectorPdfErrorFallback,
} from "@/components/inspector/inspector-pdf-error-fallback";
import { InspectorRestoreHold } from "@/components/inspector/inspector-restore-hold";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import type { LegalFilePdfView } from "@/components/inspector/legal-file-pdf-view";
import { MarkdownFileViewer } from "@/components/inspector/markdown-file-viewer";
import { PlainTextFileViewer } from "@/components/inspector/plain-text-file-viewer";
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
import {
  RecoverableViewerBoundary,
  type ViewerSurface,
} from "@/components/viewer/recoverable-viewer-boundary";
import { env } from "@/env";
import type { TranslationKey } from "@/i18n/types";
import { PDF_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { isPreviewUnavailableError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { PDFColorMode } from "@/lib/pdf/pdf-color-mode";

const AsicFileViewer = lazy(async () => {
  const m = await import("@/components/inspector/asic-file-viewer");
  return { default: m.AsicFileViewer };
});

const CadesFileViewer = lazy(async () => {
  const m = await import("@/components/inspector/cades-file-viewer");
  return { default: m.CadesFileViewer };
});

const SignatureFileViewer = lazy(async () => {
  const m = await import("@/components/inspector/signature-file-viewer");
  return { default: m.SignatureFileViewer };
});

const DataBoxFileViewer = lazy(async () => {
  const m = await import("@/features/correspondence/data-box-file-viewer");
  return { default: m.DataBoxFileViewer };
});

const EInvoiceViewer = lazy(async () => {
  const m = await import("@/components/inspector/e-invoice-viewer");
  return { default: m.EInvoiceViewer };
});

const ManualRedactionPageLayer = lazy(async () => {
  const m =
    await import("@/components/pdf/manual-redaction/manual-redaction-page-layer");
  return { default: m.ManualRedactionPageLayer };
});

const SignedDossierViewer = lazy(async () => {
  const m = await import("@/components/inspector/signed-dossier-viewer");
  return { default: m.SignedDossierViewer };
});

const ZipArchiveViewer = lazy(async () => {
  const m = await import("@/components/inspector/zip-archive-viewer");
  return { default: m.ZipArchiveViewer };
});

const MailboxViewer = lazy(async () => {
  const m = await import("@/components/inspector/mailbox-viewer");
  return { default: m.MailboxViewer };
});

const StructuredDocumentViewer = lazy(async () => {
  const m = await import("@/components/inspector/structured-document-viewer");
  return { default: m.StructuredDocumentViewer };
});

type LegalFileViewer = {
  Viewer: ComponentType<{
    onDownload: () => void;
    pdfView: LegalFilePdfView;
    tab: FileTab;
  }>;
  unreadable: TranslationKey;
  download: TranslationKey;
  surface: ViewerSurface;
};

const asicFileViewer = {
  Viewer: AsicFileViewer,
  unreadable: "signedFile.unreadable",
  download: "common.downloadOriginal",
  surface: "inspector-asic",
} as const satisfies LegalFileViewer;

const signedDossierViewer = {
  Viewer: SignedDossierViewer,
  unreadable: "signedFile.unreadable",
  download: "common.downloadOriginal",
  surface: "inspector-signed-dossier",
} as const satisfies LegalFileViewer;

const structuredDocumentViewer = {
  Viewer: StructuredDocumentViewer,
  unreadable: "structuredDocument.noReadableContent",
  download: "common.downloadOriginal",
  surface: "inspector-structured-document",
} as const satisfies LegalFileViewer;

const eInvoiceViewer = {
  Viewer: EInvoiceViewer,
  unreadable: "eInvoice.unreadable",
  download: "common.downloadOriginal",
  surface: "inspector-e-invoice",
} as const satisfies LegalFileViewer;

const signatureFileViewer = {
  Viewer: SignatureFileViewer,
  unreadable: "signedFile.unreadable",
  download: "common.downloadOriginal",
  surface: "inspector-signature",
} as const satisfies LegalFileViewer;

const legalFileViewers = {
  asicE: asicFileViewer,
  asicS: asicFileViewer,
  eAkta: signedDossierViewer,
  zep: signedDossierViewer,
  xadesZep: signedDossierViewer,
  cades: {
    Viewer: CadesFileViewer,
    unreadable: "signedFile.unreadable",
    download: "common.downloadOriginal",
    surface: "inspector-cades",
  },
  cadesDetached: signatureFileViewer,
  xades: signatureFileViewer,
  ofd: structuredDocumentViewer,
  uyap: structuredDocumentViewer,
  isdoc: eInvoiceViewer,
  isdocx: eInvoiceViewer,
  // Any XML file opens here: an invoice as one, other XML as its text.
  xml: { ...eInvoiceViewer, unreadable: "eInvoice.xmlUnreadable" },
  dataBox: {
    Viewer: DataBoxFileViewer,
    unreadable: "correspondence.dataBox.unreadable",
    download: "common.download",
    surface: "inspector-data-box",
  },
  zip: {
    Viewer: ZipArchiveViewer,
    unreadable: "inspector.fileParts.archiveUnreadable",
    download: "common.downloadOriginal",
    surface: "inspector-zip",
  },
  mbox: {
    Viewer: MailboxViewer,
    unreadable: "inspector.mailbox.unreadable",
    download: "common.downloadOriginal",
    surface: "inspector-mbox",
  },
  pst: {
    Viewer: MailboxViewer,
    unreadable: "inspector.mailbox.unreadable",
    download: "common.downloadOriginal",
    surface: "inspector-mbox",
  },
} as const satisfies Record<LegalFileFormatKind, LegalFileViewer>;

/**
 * A legal file in its format's viewer; a file its reader refuses shows why,
 * with its download.
 */
const LegalFileTabViewer = ({
  kind,
  onDownload,
  pdfView,
  tab,
}: {
  kind: LegalFileFormatKind;
  onDownload: () => void;
  pdfView: LegalFilePdfView;
  tab: FileTab;
}) => {
  const t = useTranslations();
  const { Viewer, unreadable, download, surface } = legalFileViewers[kind];
  return (
    <RecoverableViewerBoundary
      finalFallback={(error) =>
        isPreviewUnavailableError(error) ? (
          <FilePreviewUnavailable
            downloadLabel={t(download)}
            message={t(unreadable)}
            onDownload={onDownload}
          />
        ) : undefined
      }
      onDownload={onDownload}
      surface={surface}
    >
      <Suspense fallback={<PeekSuspenseFallback />}>
        <Viewer onDownload={onDownload} pdfView={pdfView} tab={tab} />
      </Suspense>
    </RecoverableViewerBoundary>
  );
};

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
  onViewerError: (error: unknown) => void;
  pdfColorMode: PDFColorMode;
  peekPdfViewId: string;
  tab: FileTab;
};

/**
 * The file itself, in the viewer its format needs, under the AI source bar
 * when the tab carries a justification.
 */
/**
 * A `.sig` or `.xml` file is a signature only if the server reads one in its
 * bytes; any other file keeps the viewer it always had.
 */
const SignatureProbe = ({
  fallback,
  onDownload,
  tab,
}: {
  fallback: ReactNode;
  onDownload: () => void;
  tab: FileTab;
}): ReactNode =>
  signatureFormatCandidate(tab.mimeType, tab.fileName) === undefined ? (
    fallback
  ) : (
    <RecoverableViewerBoundary
      finalFallback={(error): ReactNode =>
        isPreviewUnavailableError(error) ? fallback : undefined
      }
      key={tab.id}
      onDownload={onDownload}
      surface="inspector-signature"
    >
      <Suspense fallback={<PeekSuspenseFallback />}>
        <SignatureFileViewer
          notSignature={fallback}
          onDownload={onDownload}
          tab={tab}
        />
      </Suspense>
    </RecoverableViewerBoundary>
  );

const FileTabViewerComponent = ({
  canUpdateEntity,
  closeAll,
  desktopEditTarget,
  display: {
    isActive,
    isEmailDisplay,
    isMarkdownDisplay,
    nativePreviewKind,
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
  const officeResetKeys = [tab.id];
  const officeSuspenseFallback = (
    <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center text-sm">
      {t("common.loading")}
    </div>
  );
  const docxDocument = {
    entityId: tab.entityId,
    fileFieldId: tab.id,
    propertyId: entity.filePropertyId ?? "",
    workspaceId: tab.workspaceId,
  };
  const docxFallback = <PeekSuspenseFallback />;
  const handlePdfWheelZoom = (deltaY: number) =>
    handleWheelZoom(tab.id, deltaY);
  const handleReset = () => handleResetZoom(tab.id);
  const handleZoomDirection = (direction: "in" | "out") =>
    handleZoom(tab.id, direction);
  const zoomOverlay = (
    colorControl: ReturnType<typeof getPeekPDFColorControl>,
  ) => (
    <ViewerOverlayBar>
      <PeekPdfControls
        onReset={handleReset}
        onZoom={handleZoomDirection}
        pdfColorControl={colorControl}
        scaleOffset={scaleOffset}
      />
    </ViewerOverlayBar>
  );
  // A legal file that holds a PDF draws it with the same zoom, colour mode
  // and controls as a PDF tab; the viewer places the controls over its PDF.
  const legalFilePdfView: LegalFilePdfView = {
    colorMode: pdfColorMode,
    controls: zoomOverlay({
      colorMode: pdfColorMode,
      onColorModeChange: onPdfColorModeChange,
    }),
    onWheelZoom: handlePdfWheelZoom,
    scaleOffset,
  };

  const handleDownload = () => {
    detached(
      downloadTabFile({
        fieldId: tab.id,
        fileName: tab.fileName,
        variant: "original",
        workspaceId: tab.workspaceId,
        onError: (message, error) => {
          notifyUserError(error, message);
        },
      }),
      "file-tab-viewer.download",
    );
  };

  const probeSignature = (fallback: ReactNode): ReactNode => (
    <SignatureProbe fallback={fallback} onDownload={handleDownload} tab={tab} />
  );

  // Explicit ReactNode: a probed fallback is typed ReactNode, whose React 19
  // Promise<AwaitedReactNode> member promise-function-async would flag.
  const fileViewer = ((): ReactNode => {
    switch (nativePreviewKind) {
      case "asicE":
      case "asicS":
      case "cades":
      case "cadesDetached":
      case "xades":
      case "dataBox":
      case "eAkta":
      case "xadesZep":
      case "zep":
      case "ofd":
      case "uyap":
      case "isdoc":
      case "isdocx":
      case "xml":
      case "zip":
      case "mbox":
      case "pst": {
        const legalViewer = (
          <LegalFileTabViewer
            key={tab.id}
            kind={nativePreviewKind}
            onDownload={handleDownload}
            pdfView={legalFilePdfView}
            tab={tab}
          />
        );
        // An `.xml` file may be an XAdES signature; the server decides from
        // its bytes, and any other XML keeps its own viewer.
        return nativePreviewKind === "xml"
          ? probeSignature(legalViewer)
          : legalViewer;
      }
      case "email":
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
      case "markdown":
        return (
          <MarkdownFileViewer
            draft={markdown}
            readOnly={!canUpdateEntity}
            tabId={tab.id}
          />
        );
      case "text":
        return probeSignature(<PlainTextFileViewer tab={tab} />);
      case "audio":
        return <AudioFileViewer onDownload={handleDownload} tab={tab} />;
      case "xlsx":
      case "pptx":
        return (
          <QuerySuspenseBoundary
            area="office-file-viewer"
            errorFallback={viewerErrorFallback}
            resetKeys={officeResetKeys}
            suspenseFallback={officeSuspenseFallback}
          >
            <OfficeFileViewer
              desktopEditTarget={desktopEditTarget}
              entityId={tab.entityId}
              fieldId={tab.id}
              fileName={tab.fileName}
              format={nativePreviewKind}
              key={tab.id}
              workspaceId={tab.workspaceId}
            />
          </QuerySuspenseBoundary>
        );
      case "docx":
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
            <InspectorRestoreHold ready={docxEditor.isDocumentReady} />
            <DocxEditorSlot
              bindings={docxEditor.bindings}
              canUnlock={canUpdateEntity}
              document={docxDocument}
              fallback={docxFallback}
              initialScrollTop={docxInitialScrollTop}
              isEditing={isEditingNativeDocx}
              scaleOffset={scaleOffset}
              slot={DOCX_EDITOR_SLOT.inspector}
            />
          </>
        );
      case "pdf":
      case null: {
        const pdfViewer =
          entity.conversionRefusal === undefined ? (
            <PeekPdfViewer
              pdfPageSource="portfolio"
              activePropertyId={entity.filePropertyId ?? ""}
              entityId={tab.entityId}
              errorFallback={viewerErrorFallback}
              fieldId={tab.id}
              filePurpose="display"
              colorMode={pdfColorMode}
              mimeType={tab.mimeType ?? undefined}
              onDocxScrollTopChange={docxEditor.handleScrollTopChange}
              onDownload={handleDownload}
              onError={onViewerError}
              onPeekNavigate={closeAll}
              onWheelZoom={handlePdfWheelZoom}
              pdfPageOverlay={
                env.VITE_FEATURE_PDF_AREA_REDACTION
                  ? (pageId) => (
                      <Suspense fallback={null}>
                        <ManualRedactionPageLayer
                          fieldId={tab.id}
                          pageId={pageId}
                        />
                      </Suspense>
                    )
                  : undefined
              }
              scaleOffset={scaleOffset}
              underOverlayBar={isZoomOverlayVisible}
              viewId={peekPdfViewId}
              workspaceId={tab.workspaceId}
            />
          ) : (
            <ConversionRefusalFallback
              onDownload={handleDownload}
              refusal={entity.conversionRefusal}
            />
          );
        return nativePreviewKind === null
          ? probeSignature(pdfViewer)
          : pdfViewer;
      }
      default:
        nativePreviewKind satisfies never;
        return panic("Unhandled native file preview");
    }
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
          {isZoomOverlayVisible ? zoomOverlay(pdfColorControl) : null}
        </div>
      </div>
    </div>
  );
};

export const FileTabViewer = memo(FileTabViewerComponent);
