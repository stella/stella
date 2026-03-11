/**
 * Shared drag preview renderer for entity drags.
 * Creates a compact preview showing icon + file name.
 *
 * Uses flushSync + createRoot to render the real DocumentIcon
 * synchronously (drag previews must be in the DOM before the
 * render callback returns).
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { FolderIcon } from "lucide-react";

import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

export type DragPreviewData = {
  name: string;
  kind: string;
  mimeType: string | null;
};

const cardStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  borderRadius: 6,
  background: "var(--color-card, #fff)",
  border: "1px solid var(--color-border, #e5e5e5)",
  boxShadow: "0 2px 8px rgba(0,0,0,.12)",
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
  maxWidth: 220,
  whiteSpace: "nowrap" as const,
  color: "var(--color-foreground, #111)",
} as const;

const ItemIcon = ({ data }: { data: DragPreviewData }) => {
  if (data.kind === "folder") {
    return createElement(FolderIcon, {
      className: "size-3.5 shrink-0 text-muted-foreground",
    });
  }
  if (data.mimeType) {
    return createElement(DocumentIcon, {
      mimeType: data.mimeType,
      className: "size-3.5 shrink-0",
    });
  }
  return null;
};

const PreviewContent = ({ data }: { data: DragPreviewData }) =>
  createElement(
    "div",
    { style: cardStyle },
    createElement(ItemIcon, { data }),
    createElement(
      "span",
      { style: { overflow: "hidden", textOverflow: "ellipsis" } },
      data.name,
    ),
  );

const badgeStyle = {
  position: "absolute" as const,
  top: -6,
  right: -6,
  minWidth: 18,
  height: 18,
  borderRadius: 9,
  background: "var(--color-primary, #2563eb)",
  color: "var(--color-primary-foreground, #fff)",
  fontSize: 11,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 5px",
  border: "2px solid var(--color-card, #fff)",
} as const;

const MultiPreviewContent = ({ items }: { items: DragPreviewData[] }) => {
  // SAFETY: caller (renderMultiDragPreview) guards items.length > 1.
  const first = items[0];
  const count = items.length;

  // Stacked cards effect: two offset cards behind the front one.
  return createElement(
    "div",
    {
      style: {
        position: "relative" as const,
        padding: "6px 8px 2px 2px",
      },
    },
    // Back card (offset down-right)
    count > 2 &&
      createElement("div", {
        style: {
          ...cardStyle,
          position: "absolute" as const,
          top: 10,
          left: 6,
          right: 4,
          height: 28,
          opacity: 0.4,
        },
      }),
    // Middle card (offset slightly)
    count > 1 &&
      createElement("div", {
        style: {
          ...cardStyle,
          position: "absolute" as const,
          top: 6,
          left: 3,
          right: 6,
          height: 28,
          opacity: 0.6,
        },
      }),
    // Front card (the actual item)
    createElement(
      "div",
      { style: { ...cardStyle, position: "relative" as const } },
      createElement(ItemIcon, { data: first }),
      createElement(
        "span",
        {
          style: { overflow: "hidden", textOverflow: "ellipsis" },
        },
        first.name,
      ),
      // Count badge
      createElement("div", { style: badgeStyle }, String(count)),
    ),
  );
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
