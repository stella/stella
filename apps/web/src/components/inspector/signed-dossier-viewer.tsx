import { useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import type { FileTab } from "@/components/inspector/file-tab";
import type { LegalFilePdfView } from "@/components/inspector/legal-file-pdf-view";
import { LegalFilePreviewText } from "@/components/inspector/legal-file-preview-text";
import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import {
  PeekPdfViewport,
  PeekSuspenseFallback,
} from "@/components/pdf/peek/peek-pdf-viewer";
import {
  signedDossierPdfOptions,
  signedDossierPreviewOptions,
} from "@/lib/files/legal-file-queries";

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
  const firstPdf = data.documents.findIndex(({ pdf }) => pdf);
  const [selected, setSelected] = useState(firstPdf);
  const shownPdf = data.documents[selected]?.pdf === true ? selected : -1;
  const shown = data.documents[shownPdf];

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
          shown ? "h-auto max-h-[45%] shrink-0" : "flex-1",
        )}
      >
        <article
          {...(shown ? {} : DOCKED_COMPOSER_CLEARANCE)}
          className="space-y-3 p-4"
        >
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
          <section className="text-sm">
            <h2 className="font-medium">{t("common.documents")}</h2>
            <ul className="divide-y">
              {data.documents.map(
                ({ id, fileName, pdf, status, text, textFormat }, index) => (
                  <li className="space-y-2 py-3" key={id}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="min-w-0 font-medium wrap-break-word">
                        <BidiText>{fileName}</BidiText>
                      </h3>
                      {pdf && (
                        <Button
                          aria-pressed={shownPdf === index}
                          onClick={() => {
                            setSelected(index);
                          }}
                          size="sm"
                          type="button"
                          variant={shownPdf === index ? "secondary" : "ghost"}
                        >
                          {t("common.preview")}
                        </Button>
                      )}
                    </div>
                    {!pdf && status !== "unavailable" && text.trim() ? (
                      <LegalFilePreviewText format={textFormat} text={text} />
                    ) : null}
                    {!pdf && status === "truncated" && (
                      <p className="text-muted-foreground">
                        {t("common.previewTruncated")}
                      </p>
                    )}
                    {!pdf && status === "unavailable" && (
                      <p className="text-muted-foreground">
                        {t("signedFile.noReadableContent")}
                      </p>
                    )}
                  </li>
                ),
              )}
            </ul>
          </section>
        </article>
      </ScrollArea>
      {shown && (
        // The chosen PDF is drawn by the inspector's PDF viewer, as a P7M's
        // embedded PDF is: fit to the panel, zoom controls and wheel zoom.
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
                    {shown.text.trim() ? (
                      <LegalFilePreviewText
                        format={shown.textFormat}
                        text={shown.text}
                      />
                    ) : null}
                  </div>
                </ScrollArea>
              ),
            }}
            fieldId={`signed-dossier:${tab.id}:${shown.id}`}
            initialScaleOffset={pdfView.scaleOffset}
            key={shown.id}
            onDownload={onDownload}
            surface="inspector-signed-dossier"
          >
            <SignedDossierPdf
              document={shownPdf}
              fieldId={tab.id}
              pdfView={pdfView}
              workspaceId={tab.workspaceId}
            />
          </MeasuredPdfProvider>
          {pdfView.controls}
        </div>
      )}
    </FileViewerWithAI>
  );
};

const SignedDossierPdf = ({
  document,
  fieldId,
  pdfView,
  workspaceId,
}: {
  document: number;
  fieldId: string;
  pdfView: LegalFilePdfView;
  workspaceId: string;
}) => {
  const { data: buffer } = useSuspenseQuery(
    signedDossierPdfOptions({ document, fieldId, workspaceId }),
  );
  return (
    <PeekPdfViewport
      buffer={buffer}
      colorMode={pdfView.colorMode}
      fileId={`signed-dossier:${fieldId}:${document}`}
      onWheelZoom={pdfView.onWheelZoom}
      pageSource="document"
      scaleOffset={pdfView.scaleOffset}
    />
  );
};
