import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import type { FileTab } from "@/components/inspector/file-tab";
import { asicPreviewOptions } from "@/lib/files/queries";

export const AsicFileViewer = ({
  onDownload,
  tab,
}: {
  onDownload: () => void;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    asicPreviewOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
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
          <ul className="divide-y">
            {data.members.map(({ fileName, status, text }) => (
              <li className="space-y-2 py-3" key={fileName}>
                <h2 className="text-sm font-medium wrap-break-word">
                  <BidiText>{fileName}</BidiText>
                </h2>
                {status !== "unavailable" && text.trim() ? (
                  <pre
                    className="font-sans text-sm leading-relaxed wrap-break-word whitespace-pre-wrap"
                    dir="auto"
                  >
                    {text}
                  </pre>
                ) : null}
                {status === "truncated" && (
                  <p className="text-muted-foreground text-sm">
                    {t("signedFile.previewTruncated")}
                  </p>
                )}
                {status === "unavailable" && (
                  <p className="text-muted-foreground text-sm">
                    {t("signedFile.noReadableContent")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </article>
      </ScrollArea>
    </FileViewerWithAI>
  );
};
