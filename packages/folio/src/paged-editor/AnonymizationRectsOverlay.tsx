/**
 * Anonymization Rects Overlay
 *
 * Paints anonymization-term highlights on top of the rendered
 * paged document. Decoration spans live in the hidden
 * ProseMirror editor and never reach the visible page DOM, so
 * we project the same ranges onto container-relative rectangles
 * (via {@link selectionToRects}) and stack a coloured div per
 * line on this absolutely-positioned overlay.
 *
 * Pointer events stay disabled so the underlying text selection
 * and click handling continue to work through the overlay.
 */

import React from "react";

import type { SelectionRect } from "../core/layout-bridge/selectionRects";
import { slugAnonymizationLabel } from "../core/prosemirror/plugins/anonymizationDecorations";

export type AnonymizationRectGroup = {
  /** Same shape as SelectionOverlay — adjusted into container space. */
  rects: SelectionRect[];
  /** Per-occurrence label slug (e.g. "person", "organization"). */
  label: string;
  /** Canonical surface form, surfaced through the title tooltip. */
  canonical: string;
};

export type AnonymizationRectsOverlayProps = {
  groups: AnonymizationRectGroup[];
};

const overlayStyles: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: "50%",
  width: "100vw",
  height: "100%",
  transform: "translateX(-50%)",
  pointerEvents: "none",
  zIndex: 0,
};

export const AnonymizationRectsOverlay = ({
  groups,
}: AnonymizationRectsOverlayProps) => {
  if (groups.length === 0) return null;

  return (
    <div style={overlayStyles} data-folio-anonymization-overlay="">
      {groups.flatMap((group) =>
        group.rects.map((rect, idx) => (
          <span
            // SAFETY: groups are produced from a stable iteration of
            // the plugin's decoration list; index within a group is
            // adequately unique per render.
            // oxlint-disable-next-line react/no-array-index-key
            key={`${group.label}:${group.canonical}:${idx}:${rect.pageIndex}:${rect.x}:${rect.y}`}
            className={`folio-anonymization-term folio-anonymization-term--${slugAnonymizationLabel(group.label)}`}
            data-folio-anonymization-label={group.label}
            data-folio-anonymization-canonical={group.canonical}
            title={`Anonymized: ${group.canonical}`}
            style={{
              position: "absolute",
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
            }}
          />
        )),
      )}
    </div>
  );
};
