import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

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
import { LegalFilePreviewText } from "@/components/inspector/legal-file-preview-text";
import { asicPreviewOptions } from "@/lib/files/legal-file-queries";

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
  const source = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const actions = useFilePartActions(source);
  const { open, openPart, close } = useOpenFilePart(data.members);

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
          // A member without a preview of its own still shows the text the
          // server read from it.
          fallback={
            open.status !== "unavailable" && open.text.trim() ? (
              <LegalFilePreviewText format={open.textFormat} text={open.text} />
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
        className={cn("min-h-0 flex-1", open !== null && "hidden")}
      >
        <article className="space-y-4 p-4" {...DOCKED_COMPOSER_CLEARANCE}>
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
            parts={data.members}
            title={t("common.documents")}
          />
        </article>
      </ScrollArea>
      {actions.dialog}
    </FileViewerWithAI>
  );
};
