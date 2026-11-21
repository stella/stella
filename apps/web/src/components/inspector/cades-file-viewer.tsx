import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { EInvoiceDetails } from "@/components/inspector/e-invoice-details";
import type { FileTab } from "@/components/inspector/file-tab";
import { PeekSuspenseFallback } from "@/components/pdf/peek/peek-pdf-viewer";
import { PDF_MIME } from "@/lib/consts";
import { cadesPdfOptions, cadesPreviewOptions } from "@/lib/files/queries";
import { PDFProvider } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";

export const CadesFileViewer = ({
  onDownload,
  tab,
}: {
  onDownload: () => void;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    cadesPreviewOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
  );
  const t = useTranslations();
  const hasPdf = data.mimeType === PDF_MIME;
  const textPreview = data.text.trim() ? (
    <pre
      className="font-sans text-sm leading-relaxed wrap-break-word whitespace-pre-wrap"
      dir="auto"
    >
      {data.text}
    </pre>
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
      <ScrollArea
        axis="vertical"
        className={cn(
          "min-h-0",
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
              fieldId={tab.id}
              preview={data.invoice}
              workspaceId={tab.workspaceId}
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
      {hasPdf && (
        <div className="document-preview-surface min-h-0 flex-1 border-t">
          <PDFProvider
            fallback={{
              suspense: <PeekSuspenseFallback />,
              error: () => (
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
            onDownload={onDownload}
            startPage={1}
            surface="inspector-cades"
          >
            <CadesPdf fieldId={tab.id} workspaceId={tab.workspaceId} />
          </PDFProvider>
        </div>
      )}
    </FileViewerWithAI>
  );
};

const CadesPdf = ({
  fieldId,
  workspaceId,
}: {
  fieldId: string;
  workspaceId: string;
}) => {
  const { data: buffer } = useSuspenseQuery(
    cadesPdfOptions({ fieldId, workspaceId }),
  );
  return (
    <PDFViewport
      buffer={buffer}
      className="h-full"
      contentClassName="relative mt-2 space-y-2 px-2"
      fileId={`cades:${fieldId}`}
      pageSource="document"
      renderPage={(props) => <PDFPage {...props} />}
    />
  );
};
