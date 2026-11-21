import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { structuredDocumentPreviewOptions } from "@/lib/files/legal-file-queries";

export const StructuredDocumentViewer = ({
  onDownload,
  tab,
}: {
  onDownload: () => void;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    structuredDocumentPreviewOptions({
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
        <article className="space-y-3 p-4" {...DOCKED_COMPOSER_CLEARANCE}>
          <p className="text-muted-foreground text-sm">
            {t("structuredDocument.textOnly")}
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
          <pre
            className="font-sans text-sm leading-relaxed wrap-break-word whitespace-pre-wrap"
            dir="auto"
          >
            {data.text}
          </pre>
          {data.truncated && (
            <p className="text-muted-foreground text-sm">
              {t("common.previewTruncated")}
            </p>
          )}
        </article>
      </ScrollArea>
    </FileViewerWithAI>
  );
};
