import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import {
  FilePartList,
  FilePartViewer,
  useOpenFilePart,
} from "@/components/file-parts/file-parts";
import { useFilePartActions } from "@/components/file-parts/use-file-part-actions";
import type { FileTab } from "@/components/inspector/file-tab";
import type { LegalFilePdfView } from "@/components/inspector/legal-file-pdf-view";
import { LegalFilePreviewText } from "@/components/inspector/legal-file-preview-text";
import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import {
  PeekPdfViewport,
  PeekSuspenseFallback,
} from "@/components/pdf/peek/peek-pdf-viewer";
import { PDF_MIME } from "@/lib/consts";
import { filePartContentOptions } from "@/lib/files/file-part-queries";
import { signedDossierPreviewOptions } from "@/lib/files/legal-file-queries";

type FilePartSource = { fieldId: string; workspaceId: string };

export const SignedDossierViewer = ({
  onDownload,
  pdfView,
  tab,
}: {
  onDownload: () => void;
  pdfView: LegalFilePdfView;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    signedDossierPreviewOptions({
      fieldId: tab.id,
      workspaceId: tab.workspaceId,
    }),
  );
  const t = useTranslations();
  const source = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const actions = useFilePartActions(source);
  const documents = data.documents.flatMap((entry) =>
    entry.part === null ? [] : [{ ...entry.part, document: entry }],
  );
  const { open, openPart, close } = useOpenFilePart(documents);
  // The dossier's first PDF is shown under its overview, as a signed file's
  // own PDF is; any document opens in place from the list.
  const shown = documents.find(({ mediaType }) => mediaType === PDF_MIME);
  const unreadable = data.documents.filter(({ part }) => part === null);

  return (
    <FileViewerWithAI
      activeFile={{
        entityId: tab.entityId,
        fileFieldId: tab.id,
        fileName: tab.fileName,
      }}
      className="flex h-full min-h-0 flex-col"
      workspaceId={tab.workspaceId}
    >
      {open === null ? null : (
        <FilePartViewer
          actions={actions}
          fallback={
            open.document.status !== "unavailable" &&
            open.document.text.trim() ? (
              <LegalFilePreviewText
                format={open.document.textFormat}
                text={open.document.text}
              />
            ) : null
          }
          key={open.part}
          onBack={close}
          row={open}
          source={source}
        />
      )}
      <ScrollArea
        axis="vertical"
        className={cn(
          "min-h-0",
          open !== null && "hidden",
          shown ? "h-auto max-h-[45%] shrink-0" : "flex-1",
        )}
      >
        <article
          {...(shown ? {} : DOCKED_COMPOSER_CLEARANCE)}
          className="space-y-4 p-4"
        >
          {data.receipt && (
            <h2 className="text-base font-medium">
              {t("signedFile.deliveryReceipt")}
            </h2>
          )}
          <p className="text-muted-foreground text-sm">
            {t("signedFile.unverified")}
          </p>
          <Button
            onClick={onDownload}
            size="sm"
            type="button"
            variant="outline"
          >
            <DownloadIcon />
            {t("common.downloadOriginal")}
          </Button>
          <section className="space-y-1 text-sm">
            <h2 className="font-medium">{t("signedFile.signers")}</h2>
            {data.signers.length === 0 ? (
              <p className="text-muted-foreground">
                {t("signedFile.noSigners")}
              </p>
            ) : (
              <ul className="list-inside list-disc">
                {data.signers.map((signer) => (
                  <li className="wrap-break-word" key={signer.id}>
                    <BidiText>
                      {signer.name ?? t("signedFile.unknownSigner")}
                    </BidiText>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <FilePartList
            actions={actions}
            onOpen={openPart}
            parts={documents}
            title={t("common.documents")}
          />
          {unreadable.length > 0 ? (
            <ul className="text-muted-foreground space-y-1 text-sm">
              {unreadable.map(({ id, fileName }) => (
                <li className="wrap-break-word" key={id}>
                  <BidiText>{fileName}</BidiText>
                  {" · "}
                  {t("signedFile.noReadableContent")}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      </ScrollArea>
      {shown && open === null && (
        // The PDF is drawn by the inspector's PDF viewer, as a P7M's embedded
        // PDF is: fit to the panel, zoom controls and wheel zoom.
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col border-t">
          <MeasuredPdfProvider
            active
            fallback={{
              suspense: <PeekSuspenseFallback />,
              error: (
                <ScrollArea axis="vertical" className="h-full">
                  <div className="space-y-3 p-4" {...DOCKED_COMPOSER_CLEARANCE}>
                    <p className="text-muted-foreground text-sm">
                      {t("signedFile.pdfUnavailable")}
                    </p>
                    {shown.document.text.trim() ? (
                      <LegalFilePreviewText
                        format={shown.document.textFormat}
                        text={shown.document.text}
                      />
                    ) : null}
                  </div>
                </ScrollArea>
              ),
            }}
            fieldId={`signed-dossier:${tab.id}:${shown.part}`}
            initialScaleOffset={pdfView.scaleOffset}
            key={shown.part}
            onDownload={onDownload}
            surface="inspector-signed-dossier"
          >
            <SignedDossierPdf
              part={shown.part}
              pdfView={pdfView}
              source={source}
            />
          </MeasuredPdfProvider>
          {pdfView.controls}
        </div>
      )}
      {actions.dialog}
    </FileViewerWithAI>
  );
};

const SignedDossierPdf = ({
  part,
  pdfView,
  source,
}: {
  part: string;
  pdfView: LegalFilePdfView;
  source: FilePartSource;
}) => {
  const { data: buffer } = useSuspenseQuery(
    filePartContentOptions({ ...source, part }),
  );
  return (
    <PeekPdfViewport
      buffer={buffer}
      colorMode={pdfView.colorMode}
      fileId={`signed-dossier:${source.fieldId}:${part}`}
      onWheelZoom={pdfView.onWheelZoom}
      pageSource="document"
      scaleOffset={pdfView.scaleOffset}
      underOverlayBar
    />
  );
};
