/**
 * Shared drag preview renderer for entity drags.
 * Creates a compact preview showing icon + file name.
 *
 * Uses flushSync + createRoot to render the real DocumentIcon
 * synchronously (drag previews must be in the DOM before the
 * render callback returns).
 */

import { createElement } from "react";
// eslint-disable-next-line react-doctor/no-flush-sync -- drag preview must paint before dragstart returns; browser snapshots the drag image synchronously
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import {
  MultiPreviewContent,
  PreviewContent,
} from "@/components/drag-preview-content";

export type DragPreviewData = {
  name: string;
  kind: string;
  mimeType: string | null;
};

/**
 * Render a compact drag preview into the given container.
 * Returns a cleanup function for unmounting React.
 */
export const renderDragPreview = (
  container: HTMLElement,
  data: DragPreviewData,
): (() => void) => {
  const root = createRoot(container);
  flushSync(() => {
    root.render(createElement(PreviewContent, { data }));
  });
  return () => root.unmount();
};

/**
 * Render a multi-item drag preview with stacked cards
 * and a count badge.
 */
export const renderMultiDragPreview = (
  container: HTMLElement,
  items: DragPreviewData[],
): (() => void) => {
  const first = items.at(0);
  if (!first || items.length <= 1) {
    // SAFETY: first is guaranteed by the caller (sel.size > 1),
    // but we guard with .at(0) to avoid silent undefined.
    return first
      ? renderDragPreview(container, first)
      : () => {
          /* noop cleanup */
        };
  }
  const root = createRoot(container);
  flushSync(() => {
    root.render(createElement(MultiPreviewContent, { items }));
  });
  return () => root.unmount();
};
