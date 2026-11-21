import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { EInvoiceDetails } from "@/components/inspector/e-invoice-details";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { eInvoicePreviewOptions } from "@/lib/files/e-invoice-queries";

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
      <ScrollArea axis="vertical" className="min-h-0 flex-1">
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
          <EInvoiceDetails
            fieldId={tab.id}
            preview={data}
            workspaceId={tab.workspaceId}
          />
        </article>
      </ScrollArea>
    </FileViewerWithAI>
  );
};
