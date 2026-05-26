import { lazy, Suspense } from "react";

import type { FileViewerWithAIProps } from "./file-viewer-with-ai.impl";

// The actual implementation pulls in `host.tsx`, `file-chat-overlay.tsx`,
// and ultimately `@stll/folio`'s AI-suggestion helpers (applySuggestions,
// resolveSuggestionAnchor, citation/decoration meta setters). Keeping
// it behind `lazy()` is what stops the Folio editor + Yjs + utif2 graph
// (~490 KB gz) from being preloaded on the homepage. The wrapper just
// renders the file viewer (`children`) while the AI overlay chunk is
// in flight, so the visible viewer never pauses for AI bytes.
const LazyFileViewerWithAI = lazy(async () => {
  const m = await import("./file-viewer-with-ai.impl");
  return { default: m.FileViewerWithAIImpl };
});

export const FileViewerWithAI = (props: FileViewerWithAIProps) => (
  <Suspense fallback={props.children}>
    <LazyFileViewerWithAI {...props} />
  </Suspense>
);
