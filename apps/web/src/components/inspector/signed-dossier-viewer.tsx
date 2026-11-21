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
import { PeekSuspenseFallback } from "@/components/pdf/peek/peek-pdf-viewer";
import {
  signedDossierPdfOptions,
  signedDossierPreviewOptions,
} from "@/lib/files/legal-file-queries";
import { PDFProvider } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";

export const SignedDossierViewer = ({
  onDownload,
  tab,
}: {
  onDownload: () => void;
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
  const hasPdf = shownPdf !== -1;

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
          hasPdf ? "h-auto max-h-[45%] shrink-0" : "flex-1",
        )}
      >
        <article
          {...(hasPdf ? {} : DOCKED_COMPOSER_CLEARANCE)}
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
              {data.documents.map(({ fileName, pdf, status, text }, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- names can repeat in a container; the server's position is the document's identity.
                <li className="space-y-2 py-3" key={index}>
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
                    <pre
                      className="font-sans leading-relaxed wrap-break-word whitespace-pre-wrap"
                      dir="auto"
                    >
                      {text}
                    </pre>
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
              ))}
            </ul>
          </section>
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
                    <pre
                      className="font-sans text-sm leading-relaxed wrap-break-word whitespace-pre-wrap"
                      dir="auto"
                    >
                      {data.documents[shownPdf]?.text}
                    </pre>
                  </div>
                </ScrollArea>
              ),
            }}
            fieldId={`signed-dossier:${tab.id}:${shownPdf}`}
            key={shownPdf}
            onDownload={onDownload}
            startPage={1}
            surface="inspector-signed-dossier"
          >
            <SignedDossierPdf
              document={shownPdf}
              fieldId={tab.id}
              workspaceId={tab.workspaceId}
            />
          </PDFProvider>
        </div>
      )}
    </FileViewerWithAI>
  );
};

const SignedDossierPdf = ({
  document,
  fieldId,
  workspaceId,
}: {
  document: number;
  fieldId: string;
  workspaceId: string;
}) => {
  const { data: buffer } = useSuspenseQuery(
    signedDossierPdfOptions({ document, fieldId, workspaceId }),
  );
  return (
    <PDFViewport
      buffer={buffer}
      className="h-full"
      contentClassName="relative mt-2 space-y-2 px-2"
      fileId={`signed-dossier:${fieldId}:${document}`}
      pageSource="document"
      renderPage={(props) => <PDFPage {...props} />}
    />
  );
};
