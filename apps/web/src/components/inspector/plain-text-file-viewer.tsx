import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { detached } from "@/lib/detached";
import { textFileOptions } from "@/lib/files/queries";

export const PlainTextFileViewer = ({ tab }: PlainTextFileViewerProps) => {
  const t = useTranslations();
  const textQuery = useQuery(
    textFileOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
  );
  const body = (() => {
    if (textQuery.isPending) {
      return (
        <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
          {t("common.loading")}
        </div>
      );
    }
    if (textQuery.isError) {
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-muted-foreground max-w-sm text-sm">
            {textQuery.error.message || t("errors.actionFailed")}
          </p>
          <Button
            onClick={() => {
              detached(textQuery.refetch(), "plain-text-file-viewer.refetch");
            }}
            size="xs"
            variant="secondary"
          >
            {t("common.retry")}
          </Button>
        </div>
      );
    }
    return (
      <ScrollArea axis="vertical" className="min-h-0 flex-1">
        <pre
          className="text-foreground p-6 font-sans text-sm leading-6 wrap-break-word whitespace-pre-wrap"
          dir="auto"
        >
          {textQuery.data.text}
        </pre>
      </ScrollArea>
    );
  })();

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
      {body}
    </FileViewerWithAI>
  );
};

type PlainTextFileViewerProps = {
  tab: FileTab;
};
