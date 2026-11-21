import type { ReactNode } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type {
  SignaturePreview,
  SignedFileBinding,
} from "@stll/api-contract/signature";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { openEntityInInspector } from "@/components/chat/entity-open";
import type { FileTab } from "@/components/inspector/file-tab";
import { FilePreviewUnavailable } from "@/components/inspector/inspector-pdf-error-fallback";
import { PeekSuspenseFallback } from "@/components/pdf/peek/peek-pdf-viewer";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { PDF_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import {
  signaturePdfOptions,
  signaturePreviewOptions,
} from "@/lib/files/queries";
import { PDFProvider } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

type Signature = Extract<SignaturePreview, { type: "signature" }>;

const BINDING_KEYS = {
  digestMatches: "signedFile.bindingMatches",
  digestDiffers: "signedFile.bindingDiffers",
  notCompared: "signedFile.bindingNotCompared",
} as const satisfies Record<SignedFileBinding, TranslationKey>;

const SignedFiles = ({
  signature: { signedFiles, statedFileNames },
  workspaceId,
}: {
  signature: Signature;
  workspaceId: string;
}) => {
  const router = useRouter();
  const t = useTranslations();
  const listed = new Set(signedFiles.map(({ fileName }) => fileName));
  const unlisted = statedFileNames.filter((name) => !listed.has(name));
  return (
    <section className="space-y-2 text-sm">
      <h3 className="font-medium">{t("signedFile.signs")}</h3>
      {signedFiles.length === 0 ? (
        <p className="text-muted-foreground">
          {t("signedFile.signedFileMissing")}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {signedFiles.map(({ entityId, fileName, binding }) => (
            <li className="min-w-0 space-y-0.5 px-3 py-2" key={entityId}>
              <Button
                className="min-w-0"
                onClick={() =>
                  detached(
                    openEntityInInspector({
                      documentOnScreen: getCurrentWorkspaceDocument(
                        router.state.matches,
                      ),
                      entityId,
                      label: fileName,
                      workspaceId,
                    }),
                    "signature.open-signed-file",
                  )
                }
                size="sm"
                type="button"
                variant="link"
              >
                <TruncatedText dir="auto" render={<bdi />}>
                  {fileName}
                </TruncatedText>
              </Button>
              <p className="text-muted-foreground text-xs">
                {t(BINDING_KEYS[binding])}
              </p>
            </li>
          ))}
        </ul>
      )}
      {unlisted.length > 0 && (
        <div className="text-muted-foreground space-y-1">
          <p>{t("signedFile.statedFilesMissing")}</p>
          <ul className="list-inside list-disc">
            {unlisted.map((fileName) => (
              <li className="wrap-break-word" key={fileName}>
                <bdi dir="auto">{fileName}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
      {signedFiles.some(({ binding }) => binding !== "notCompared") && (
        <p className="text-muted-foreground text-xs text-pretty">
          {t("signedFile.digestNote")}
        </p>
      )}
    </section>
  );
};

/**
 * A detached, enveloping or enveloped signature: who signed (unverified),
 * the document it carries, and the matter documents it appears to sign. A
 * `.sig` or `.xml` file that turns out not to be a signature renders
 * `notSignature`, the viewer it would have had otherwise.
 */
export const SignatureFileViewer = ({
  notSignature,
  onDownload,
  tab,
}: {
  notSignature?: ReactNode;
  onDownload: () => void;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    signaturePreviewOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
  );
  const t = useTranslations();
  const format = useFormatter();
  if (data.type === "notSignature") {
    return (
      notSignature ?? (
        <FilePreviewUnavailable
          downloadLabel={t("common.downloadOriginal")}
          message={t("signedFile.unreadable")}
          onDownload={onDownload}
        />
      )
    );
  }
  const { document, signers, packaging } = data;
  const hasPdf = document?.mimeType === PDF_MIME;
  const text = document?.text.trim() ? (
    <pre
      className="font-sans text-sm leading-relaxed wrap-break-word whitespace-pre-wrap"
      dir="auto"
    >
      {document.text}
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
          className="space-y-4 p-4"
        >
          <header className="space-y-1">
            <h2 className="text-base font-medium wrap-break-word">
              <BidiText>{document?.fileName ?? tab.fileName}</BidiText>
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("signedFile.unverified")}
            </p>
          </header>
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
            <h3 className="font-medium">{t("signedFile.signers")}</h3>
            <ul className="space-y-1">
              {signers.map((signer) => (
                <li className="wrap-break-word" key={signer.id}>
                  <BidiText>
                    {signer.name ?? t("signedFile.unknownSigner")}
                  </BidiText>
                  {signer.signedAt !== null && (
                    <span className="text-muted-foreground block text-xs tabular-nums">
                      {t("signedFile.signedAt", {
                        time: format.dateTime(
                          new Date(signer.signedAt),
                          MEDIUM_DATE_SHORT_TIME_FORMAT,
                        ),
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
          {packaging === "detached" && (
            <SignedFiles signature={data} workspaceId={tab.workspaceId} />
          )}
          {packaging !== "detached" &&
            !hasPdf &&
            (text ?? (
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
                    {text}
                  </div>
                </ScrollArea>
              ),
            }}
            fieldId={`signature:${tab.id}`}
            onDownload={onDownload}
            startPage={1}
            surface="inspector-signature"
          >
            <SignaturePdf fieldId={tab.id} workspaceId={tab.workspaceId} />
          </PDFProvider>
        </div>
      )}
    </FileViewerWithAI>
  );
};

const SignaturePdf = ({
  fieldId,
  workspaceId,
}: {
  fieldId: string;
  workspaceId: string;
}) => {
  const { data: buffer } = useSuspenseQuery(
    signaturePdfOptions({ fieldId, workspaceId }),
  );
  return (
    <PDFViewport
      buffer={buffer}
      className="h-full"
      contentClassName="relative mt-2 space-y-2 px-2"
      fileId={`signature:${fieldId}`}
      pageSource="document"
      renderPage={(props) => <PDFPage {...props} />}
    />
  );
};
