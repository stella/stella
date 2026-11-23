import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import {
  FilePartViewer,
  useOpenFilePart,
} from "@/components/file-parts/file-parts";
import { useFilePartActions } from "@/components/file-parts/use-file-part-actions";
import { EInvoiceDetails } from "@/components/inspector/e-invoice-details";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { eInvoicePreviewOptions } from "@/lib/files/legal-file-queries";

export const EInvoiceViewer = ({
  onDownload,
  tab,
}: {
  onDownload: () => void;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    eInvoicePreviewOptions({
      fieldId: tab.id,
      workspaceId: tab.workspaceId,
    }),
  );
  const t = useTranslations();
  const source = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const actions = useFilePartActions(source);
  const { open, openPart, close } = useOpenFilePart(
    data.type === "invoice" ? data.invoice.attachments : [],
  );

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
          key={open.part}
          onBack={close}
          row={open}
          source={source}
        />
      )}
      <ScrollArea
        axis="vertical"
        className={cn("min-h-0 flex-1", open !== null && "hidden")}
      >
        <article className="space-y-4 p-4" {...DOCKED_COMPOSER_CLEARANCE}>
          <Button
            onClick={onDownload}
            size="sm"
            type="button"
            variant="outline"
          >
            <DownloadIcon />
            {t("common.downloadOriginal")}
          </Button>
          {data.type === "invoice" ? (
            <EInvoiceDetails
              actions={actions}
              onOpenAttachment={openPart}
              preview={data.invoice}
            />
          ) : (
            // XML that holds no invoice: its own markup, indented.
            <>
              <pre
                className="font-mono text-sm leading-relaxed wrap-break-word whitespace-pre-wrap"
                dir="ltr"
              >
                {data.text}
              </pre>
              {data.truncated && (
                <p className="text-muted-foreground text-sm">
                  {t("common.previewTruncated")}
                </p>
              )}
            </>
          )}
        </article>
      </ScrollArea>
      {actions.dialog}
    </FileViewerWithAI>
  );
};
