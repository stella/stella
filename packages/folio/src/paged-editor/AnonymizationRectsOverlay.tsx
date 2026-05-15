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
 * Pointer events stay disabled on every node so text selection,
 * caret placement, drag-selects, and the editor's own
 * mousedown/click handlers continue to work through the
 * overlay. The sidebar bridge instead listens on `document`
 * for clicks and hit-tests the click coordinates against the
 * overlay spans via `elementsFromPoint`. That way the editor
 * still receives the click and the bridge fires alongside it,
 * with no contention over `mousedown`.
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
   * forward to a sidebar-bridge store. The overlay uses a
   * `document`-level click + hit-test to detect this, leaving
   * the editor's own mousedown/click handlers untouched.
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
  // All spans grouped by canonical. Repeated sidebar selections
  // of the same canonical advance through `spansByCanonical`,
  // wrapping at the end, so the user isn't stuck on the first
  // occurrence and can step through every hit.
  const spansByCanonical = useRef(new Map<string, HTMLSpanElement[]>());
  spansByCanonical.current = new Map();

  // Last canonical scrolled to + index inside its span list.
  // Used to advance on repeat selections of the same canonical
  // and reset to 0 when the canonical changes.
  const cycleRef = useRef<{ canonical: string; index: number } | null>(null);

  useEffect(() => {
    if (!selectedCanonical) {
      cycleRef.current = null;
      return;
    }
    const spans = spansByCanonical.current.get(selectedCanonical) ?? [];
    if (spans.length === 0) {
      return;
    }
    let nextIndex: number;
    if (cycleRef.current?.canonical === selectedCanonical) {
      nextIndex = (cycleRef.current.index + 1) % spans.length;
    } else {
      nextIndex = 0;
    }
    cycleRef.current = { canonical: selectedCanonical, index: nextIndex };
    const el = spans[nextIndex];
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedCanonical, selectionSeq]);

  // Track the overlay's root so we only hit-test our own
  // spans and ignore clicks elsewhere in the page.
  const overlayRef = useRef<HTMLDivElement>(null);

  // Document-level hit-test. The overlay spans keep
  // `pointer-events: none`, so the editor receives clicks
  // normally (caret placement, drag-selects, the existing
  // mousedown handler on `.paged-editor__pages`). After the
  // click bubbles, we iterate the overlay spans and
  // bounding-rect-test against the click position.
  // (`elementsFromPoint` skips `pointer-events: none`
  // elements, so it can't be used here.)
  useEffect(() => {
    if (!onTermClick) {
      return;
    }
    const handleClick = (event: MouseEvent) => {
      // Ignore non-primary clicks; right-click should reach the
      // editor's context menu unchanged.
      if (event.button !== 0) {
        return;
      }
      const root = overlayRef.current;
      if (!root) {
        return;
      }
      const spans = root.querySelectorAll<HTMLElement>(
        "[data-folio-anonymization-canonical]",
      );
      // Iterate in reverse paint order so the topmost rect wins
      // when several overlap at the same point.
      for (let i = spans.length - 1; i >= 0; i--) {
        const el = spans[i];
        if (!el) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (
          event.clientX >= rect.left &&
          event.clientX < rect.right &&
          event.clientY >= rect.top &&
          event.clientY < rect.bottom
        ) {
          const canonical = el.dataset["folioAnonymizationCanonical"];
          const label = el.dataset["folioAnonymizationLabel"];
          if (canonical && label) {
            onTermClick(canonical, label);
          }
          return;
        }
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [onTermClick]);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div
      ref={overlayRef}
      style={overlayStyles}
      data-folio-anonymization-overlay=""
    >
      {groups.flatMap((group) => {
        const isSelected = selectedCanonical === group.canonical;
        return group.rects.map((rect, idx) => (
          <span
            key={`${group.label}:${group.canonical}:${idx}:${rect.pageIndex}:${rect.x}:${rect.y}`}
            ref={(node) => {
              if (node) {
                const list =
                  spansByCanonical.current.get(group.canonical) ?? [];
                list.push(node);
                spansByCanonical.current.set(group.canonical, list);
              }
            }}
            className={`folio-anonymization-term folio-anonymization-term--${slugAnonymizationLabel(group.label)}`}
            data-folio-anonymization-label={group.label}
            data-folio-anonymization-canonical={group.canonical}
            data-folio-anonymization-selected={isSelected ? "true" : undefined}
            title={`Anonymized: ${group.canonical}`}
            style={{
              position: "absolute",
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
            }}
          />
        ));
      })}
    </div>
  );
};
