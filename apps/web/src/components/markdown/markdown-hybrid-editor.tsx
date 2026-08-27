import { lazy, Suspense } from "react";

import type { MarkdownHybridEditorProps } from "./markdown-hybrid-editor.impl";

export type {
  MarkdownEditorComment,
  MarkdownHybridEditorProps,
} from "./markdown-hybrid-editor.impl";

// The implementation pulls in the editor engine, KaTeX and its stylesheets, plus
// the EditContext polyfill: browser-only and heavy. `lazy()` keeps it out of SSR
// and off routes that never open a markdown file.
const LazyMarkdownHybridEditor = lazy(async () => {
  const m = await import("./markdown-hybrid-editor.impl");
  return { default: m.MarkdownHybridEditor };
});

export const MarkdownHybridEditor = (props: MarkdownHybridEditorProps) => (
  <Suspense fallback={null}>
    <LazyMarkdownHybridEditor {...props} />
  </Suspense>
);
