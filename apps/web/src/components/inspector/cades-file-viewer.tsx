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
import { EInvoiceDetails } from "@/components/inspector/e-invoice-details";
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
import { cadesPreviewOptions } from "@/lib/files/legal-file-queries";

export const CadesFileViewer = ({
  onDownload,
  pdfView,
  tab,
}: {
  onDownload: () => void;
  pdfView: LegalFilePdfView;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    cadesPreviewOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
  );
  const t = useTranslations();
  const source = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const actions = useFilePartActions(source);
  // The signed document, and the files a signed invoice carries.
  const parts = [
    ...(data.content === null ? [] : [data.content]),
    ...(data.invoice === null ? [] : data.invoice.attachments),
  ];
  const { open, openPart, close } = useOpenFilePart(parts);
  const pdfPart =
    data.content?.mediaType === PDF_MIME ? data.content.part : null;
  const hasPdf = pdfPart !== null;
  const textPreview = data.text.trim() ? (
    <LegalFilePreviewText format={data.textFormat} text={data.text} />
  ) : null;

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
          fallback={open.part === data.content?.part ? textPreview : null}
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
          hasPdf ? "h-auto max-h-[40%] shrink-0" : "flex-1",
        )}
      >
        <article
          {...(hasPdf ? {} : DOCKED_COMPOSER_CLEARANCE)}
          className="space-y-3 p-4"
        >
          <h2 className="text-base font-medium wrap-break-word">
            <BidiText>{data.fileName}</BidiText>
          </h2>
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
          <FilePartList
            actions={actions}
            onOpen={openPart}
            parts={data.content === null ? [] : [data.content]}
            title={t("signedFile.signedDocument")}
          />
          {data.layers.map(({ id, signers }, index) => (
            <section className="space-y-1 text-sm" key={id}>
              <h3 className="font-medium">
                {t("signedFile.layer", { number: index + 1 })}
              </h3>
              <ul className="list-inside list-disc">
                {signers.map((signer) => (
                  <li className="wrap-break-word" key={signer.id}>
                    <BidiText>
                      {signer.name ?? t("signedFile.unknownSigner")}
                    </BidiText>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!hasPdf && data.invoice !== null && (
            <EInvoiceDetails
              actions={actions}
              onOpenAttachment={openPart}
              preview={data.invoice}
            />
          )}
          {!hasPdf &&
            data.invoice === null &&
            (textPreview ?? (
              <p className="text-muted-foreground text-sm">
                {t("signedFile.noReadableContent")}
              </p>
            ))}
        </article>
      </ScrollArea>
      {pdfPart !== null && open === null && (
        // The embedded PDF is drawn by the inspector's PDF viewer: it fits
        // the panel's width, follows the zoom controls floating over it and
        // zooms with the wheel, as a plain PDF file does.
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
                    {textPreview}
                  </div>
                </ScrollArea>
              ),
            }}
            fieldId={`cades:${tab.id}`}
            initialScaleOffset={pdfView.scaleOffset}
            onDownload={onDownload}
            surface="inspector-cades"
          >
            <CadesPdf part={pdfPart} pdfView={pdfView} source={source} />
          </MeasuredPdfProvider>
          {pdfView.controls}
        </div>
      )}
      {actions.dialog}
    </FileViewerWithAI>
  );
};

const CadesPdf = ({
  part,
  pdfView,
  source,
}: {
  part: string;
  pdfView: LegalFilePdfView;
  source: { fieldId: string; workspaceId: string };
}) => {
  const { data: buffer } = useSuspenseQuery(
    filePartContentOptions({ ...source, part }),
  );
  return (
    <PeekPdfViewport
      buffer={buffer}
      colorMode={pdfView.colorMode}
      fileId={`cades:${source.fieldId}`}
      onWheelZoom={pdfView.onWheelZoom}
      pageSource="document"
      scaleOffset={pdfView.scaleOffset}
    />
  );
};
