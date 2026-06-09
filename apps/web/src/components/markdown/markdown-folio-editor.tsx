import { lazy, Suspense } from "react";

import type { MarkdownFolioEditorProps } from "./markdown-folio-editor.impl";

// The implementation imports `@stll/folio` (ProseMirror editor + Yjs + fonts)
// and `@stll/folio/editor.css` — a browser-only, heavy graph. `lazy()` keeps it
// out of SSR and off routes that never open a markdown file, matching the
// file-viewer's folio-loading pattern.
const LazyMarkdownFolioEditor = lazy(async () => {
  const m = await import("./markdown-folio-editor.impl");
  return { default: m.MarkdownFolioEditor };
});

export function MarkdownFolioEditor(props: MarkdownFolioEditorProps) {
  return (
    <Suspense fallback={null}>
      <LazyMarkdownFolioEditor {...props} />
    </Suspense>
  );
}
