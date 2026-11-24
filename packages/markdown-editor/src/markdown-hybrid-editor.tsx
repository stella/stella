import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import type { MarkdownHybridEditorProps } from "./markdown-hybrid-editor.impl";

export type {
  MarkdownEditorComment,
  MarkdownHybridEditorHandle,
  MarkdownHybridEditorProps,
} from "./markdown-hybrid-editor.impl";

// The implementation pulls in the editor engine, KaTeX and its stylesheets, plus
// the EditContext polyfill: browser-only and heavy. `lazy()` keeps it out of SSR
// and away from every route and window until one shows an editor.
const LazyMarkdownHybridEditor = lazy(async () => {
  const m = await import("./markdown-hybrid-editor.impl");
  return { default: m.MarkdownHybridEditor };
});

export const MarkdownHybridEditor = ({
  fallback = null,
  ...props
}: MarkdownHybridEditorProps & {
  /** Shown while the engine loads, such as the same text read-only. */
  fallback?: ReactNode;
}) => (
  <Suspense fallback={fallback}>
    <LazyMarkdownHybridEditor {...props} />
  </Suspense>
);
