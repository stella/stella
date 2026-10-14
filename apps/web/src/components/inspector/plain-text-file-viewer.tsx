import { useQuery } from "@tanstack/react-query";

import { ScrollArea } from "@stll/ui/scroll-area";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { TextFileQueryState } from "@/components/inspector/text-file-query-state";
import { textFileOptions } from "@/lib/files/queries";

type PlainTextFileViewerProps = {
  tab: FileTab;
};

/** A plain-text file read at body size from its original bytes. */
export const PlainTextFileViewer = ({ tab }: PlainTextFileViewerProps) => {
  const textQuery = useQuery(
    textFileOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
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
      <TextFileQueryState textQuery={textQuery}>
        {({ text }) => (
          <ScrollArea axis="vertical" className="min-h-0 flex-1">
            <pre
              className="text-foreground p-6 font-sans text-sm leading-6 wrap-break-word whitespace-pre-wrap"
              dir="auto"
            >
              {text}
            </pre>
          </ScrollArea>
        )}
      </TextFileQueryState>
    </FileViewerWithAI>
  );
};
