import { lazy, Suspense } from "react";

import { cn } from "@stll/ui/lib/utils";

import type { FileViewerWithAIProps } from "./file-viewer-with-ai.impl";

// The actual implementation pulls in `host.tsx`, `file-chat-overlay.tsx`,
// and ultimately `@stll/folio`'s AI-suggestion helpers (applySuggestions,
// resolveSuggestionAnchor, citation/decoration meta setters). Keeping
// it behind `lazy()` is what stops the Folio editor + Yjs + utif2 graph
// (~490 KB gz) from being preloaded on the homepage. The wrapper just
// keeps the file viewer mounted while the AI overlay chunk is in flight,
// so the visible viewer never pauses or remounts for AI bytes.
const LazyFileChatOverlayHost = lazy(async () => {
  const m = await import("./file-viewer-with-ai.impl");
  return { default: m.FileChatOverlayHost };
});

export const FileViewerWithAI = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeExternal,
  className,
  docxEditable,
  docxEditorRef,
  requestDocxEditMode,
  children,
}: FileViewerWithAIProps) => {
  const overlayKey = [
    chatThreadId ?? "mapped-file-chat",
    workspaceId ?? "",
    activeFile?.entityId ?? "",
    activeFile?.fileFieldId ?? "",
    activeExternal?.url ?? "",
  ].join(":");

  return (
    <div
      className={cn("relative h-full w-full", className)}
      data-file-viewer-ai="true"
    >
      {children}
      <Suspense fallback={null}>
        <LazyFileChatOverlayHost
          activeExternal={activeExternal}
          activeFile={activeFile}
          chatThreadId={chatThreadId}
          docxEditable={docxEditable}
          docxEditorRef={docxEditorRef}
          key={overlayKey}
          requestDocxEditMode={requestDocxEditMode}
          workspaceId={workspaceId}
        />
      </Suspense>
    </div>
  );
};
