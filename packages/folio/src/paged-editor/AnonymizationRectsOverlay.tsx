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
 * The container has `pointer-events: none` so text selection
 * still works through it. Individual term spans opt back in
 * (`pointer-events: auto`) so clicks on a highlight are
 * captured and forwarded via {@link onTermClick} — the
 * consumer wires that to the sidebar-bridge store so the
 * inspector facet can scroll to the matching row.
 *
 * When `selectedCanonical` is set, every rect for that
 * canonical gets `data-folio-anonymization-selected="true"`
 * and the first matching rect is scrolled into view (only on
 * `selectionSeq` changes — repeated clicks of the same
 * canonical in the sidebar re-trigger the scroll).
 */

import React, { useEffect, useRef } from "react";

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
  /**
   * Called when the user clicks a highlight. Receives the
   * canonical surface form and label slug so the host can
   * forward to a sidebar-bridge store.
   */
  onTermClick?: ((canonical: string, label: string) => void) | undefined;
  /**
   * Canonical to mark as selected. Matching spans get a
   * data-attribute so CSS can highlight them; the first
   * matching rect scrolls into view on every `selectionSeq`
   * change.
   */
  selectedCanonical?: string | null | undefined;
  /**
   * Monotonically-increasing token from the bridge store.
   * Bumping it re-triggers the scroll even when the canonical
   * itself didn't change.
   */
  selectionSeq?: number | undefined;
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
  onTermClick,
  selectedCanonical = null,
  selectionSeq,
}: AnonymizationRectsOverlayProps) => {
  // Track the first span that matches the selected canonical so
  // we can scroll it into view on each seq bump. Using a ref
  // map keyed by canonical lets us look up the right element
  // without re-querying the DOM.
  const firstSpanByCanonical = useRef(new Map<string, HTMLSpanElement>());
  firstSpanByCanonical.current = new Map();

  useEffect(() => {
    if (!selectedCanonical) {
      return;
    }
    const el = firstSpanByCanonical.current.get(selectedCanonical);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedCanonical, selectionSeq]);

  if (groups.length === 0) {
    return null;
  }

  const clickable = onTermClick !== undefined;

  return (
    <div style={overlayStyles} data-folio-anonymization-overlay="">
      {groups.flatMap((group) => {
        const isSelected = selectedCanonical === group.canonical;
        return group.rects.map((rect, idx) => {
          const isFirstForCanonical = idx === 0;
          return (
            <span
              key={`${group.label}:${group.canonical}:${idx}:${rect.pageIndex}:${rect.x}:${rect.y}`}
              ref={(node) => {
                if (
                  node &&
                  isFirstForCanonical &&
                  !firstSpanByCanonical.current.has(group.canonical)
                ) {
                  // The same canonical can appear in multiple groups
                  // (e.g. classified under more than one label across
                  // occurrences); keep the *first* group's first rect
                  // so sidebar selections scroll to the earliest hit.
                  firstSpanByCanonical.current.set(group.canonical, node);
                }
              }}
              className={`folio-anonymization-term folio-anonymization-term--${slugAnonymizationLabel(group.label)}`}
              data-folio-anonymization-label={group.label}
              data-folio-anonymization-canonical={group.canonical}
              data-folio-anonymization-selected={
                isSelected ? "true" : undefined
              }
              title={`Anonymized: ${group.canonical}`}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? -1 : undefined}
              onClick={
                clickable
                  ? (event) => {
                      event.stopPropagation();
                      onTermClick(group.canonical, group.label);
                    }
                  : undefined
              }
              style={{
                position: "absolute",
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
                pointerEvents: clickable ? "auto" : "none",
                cursor: clickable ? "pointer" : undefined,
              }}
            />
          );
        });
      })}
    </div>
  );
};
