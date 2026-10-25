import { Suspense } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { ScrollArea } from "@stll/ui/scroll-area";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { RecoverableViewerBoundary } from "@/components/viewer/recoverable-viewer-boundary";
import { textFileOptions } from "@/lib/files/queries";

type PlainTextFileViewerProps = {
  tab: FileTab;
};

const PlainTextLoading = () => {
  const t = useTranslations();
  return (
    <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
      {t("common.loading")}
    </div>
  );
};

const PlainTextBody = ({ tab }: PlainTextFileViewerProps) => {
  const { data } = useSuspenseQuery(
    textFileOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
  );
  return (
    <FileViewerWithAI
      activeFile={{
        entityId: tab.entityId,
        fileFieldId: tab.id,
        fileName: data.fileName,
      }}
      className="flex h-full min-h-0 flex-col"
      workspaceId={tab.workspaceId}
    >
      <ScrollArea axis="vertical" className="min-h-0 flex-1">
        <pre
          className="text-foreground p-6 font-sans text-sm leading-6 wrap-break-word whitespace-pre-wrap"
          dir="auto"
        >
          {data.text}
        </pre>
      </ScrollArea>
    </FileViewerWithAI>
  );
};

/**
 * A plain-text file read at body size from its original bytes. Loading,
 * retries and a failed read belong to the shared viewer boundary.
 */
export const PlainTextFileViewer = ({ tab }: PlainTextFileViewerProps) => (
  <div className="flex h-full min-h-0 flex-col">
    <RecoverableViewerBoundary key={tab.id} surface="inspector-text">
      <Suspense fallback={<PlainTextLoading />}>
        <PlainTextBody tab={tab} />
      </Suspense>
    </RecoverableViewerBoundary>
  </div>
);
