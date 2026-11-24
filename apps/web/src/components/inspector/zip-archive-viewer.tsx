import { useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  LIST_SEARCH_MIN_ROWS,
  listRowMatches,
} from "@stll/api-contract/list-search";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { SearchField } from "@stll/ui/search-field";
import { cn } from "@stll/ui/utils";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import {
  ContainedFileList,
  FilePartViewer,
  useOpenFilePart,
} from "@/components/file-parts/file-parts";
import { useFilePartActions } from "@/components/file-parts/use-file-part-actions";
import type { FileTab } from "@/components/inspector/file-tab";
import { LegalFilePreviewText } from "@/components/inspector/legal-file-preview-text";
import { zipArchivePreviewOptions } from "@/lib/files/legal-file-queries";

/**
 * A ZIP archive: its files in the archive's order with their folders, each
 * opening in place through the part link; a file that does not open
 * (encrypted, a link, damaged) is listed with the reason.
 */
export const ZipArchiveViewer = ({
  onDownload,
  tab,
}: {
  onDownload: () => void;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    zipArchivePreviewOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
  );
  const t = useTranslations();
  const source = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const actions = useFilePartActions(source);
  const parts = data.files.flatMap((file) =>
    file.part === null
      ? []
      : [{ ...file.part, detail: file.folder, reading: file }],
  );
  const { open, openPart, close } = useOpenFilePart(parts);
  const [query, setQuery] = useState("");
  const shown = data.files.filter(({ fileName, folder }) =>
    listRowMatches([fileName, folder], query),
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
          // A file without a preview of its own still shows the text the
          // server read from it.
          fallback={
            open.reading.status !== "unavailable" &&
            open.reading.text.trim() ? (
              <LegalFilePreviewText
                format={open.reading.textFormat}
                text={open.reading.text}
              />
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
          <Button
            onClick={onDownload}
            size="sm"
            type="button"
            variant="outline"
          >
            <DownloadIcon />
            {t("common.downloadOriginal")}
          </Button>
          {data.files.length >= LIST_SEARCH_MIN_ROWS ? (
            <SearchField
              aria-label={t("inspector.fileParts.search")}
              clearLabel={t("common.clearSearch")}
              onValueChange={setQuery}
              placeholder={t("inspector.fileParts.search")}
              value={query}
            />
          ) : null}
          {data.files.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("inspector.fileParts.noFilesInside")}
            </p>
          ) : null}
          {data.files.length > 0 && shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("inspector.fileParts.noMatches", { query: query.trim() })}
            </p>
          ) : null}
          <ContainedFileList
            actions={actions}
            files={shown}
            onOpen={openPart}
            title={t("common.files")}
          />
        </article>
      </ScrollArea>
      {actions.dialog}
    </FileViewerWithAI>
  );
};
