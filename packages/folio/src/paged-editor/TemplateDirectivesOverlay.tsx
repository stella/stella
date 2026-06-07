/**
 * Template Directives Overlay
 *
 * Paints a subtle, translucent highlight over each {{...}} marker's range so a
 * marker reads as a token while staying fully visible and editable: the
 * highlight is faint and `pointer-events: none`, so the real text shows through
 * and the caret lands in it normally. Because it's a tint (not an opaque cover),
 * minor misalignment during reflow is invisible — no flicker. Block directives
 * additionally get a thin left gutter rail spanning opener→closer.
 *
 * Appearance lives in editor.css (`.folio-template-*`, --doc-* tokens); only
 * positioning is inline.
 */

import type { CSSProperties } from "react";

import type { SelectionRect } from "../core/layout-bridge/selectionRects";
import type {
  DirectiveKind,
  DirectiveRange,
} from "../core/prosemirror/plugins/templateDirectives";

export type DirectiveRectGroup = {
  range: DirectiveRange;
  rects: SelectionRect[];
};

export type TemplateDirectivesOverlayProps = {
  groups: DirectiveRectGroup[];
  /**
   * Stable text-column left edge (container space). The rail anchors to this
   * rather than the block opener's re-projected `rects[0].x`, so it doesn't
   * drift sideways as text above it reflows during editing.
   */
  contentLeft: number | null;
};

const overlayStyles: CSSProperties = {
  position: "absolute",
  top: 0,
  left: "50%",
  width: "100vw",
  height: "100%",
  transform: "translateX(-50%)",
  pointerEvents: "none",
  zIndex: 10,
};

const BLOCK_OPENERS = new Set<DirectiveKind>(["if", "each"]);
const BLOCK_CLOSERS = new Set<DirectiveKind>(["endif", "endeach"]);
const RAIL_BASE_GUTTER = 12;
const RAIL_DEPTH_GAP = 5;
const RAIL_WIDTH = 2;

type Band = {
  top: number;
  bottom: number;
  railX: number;
};

/**
 * Pair opener/closer block directives with a stack so each conditional/loop
 * region knows its top, bottom, and nesting depth (for the gutter rail).
 * Unbalanced directives are skipped. The rail's horizontal position comes from
 * the stable `contentLeft` anchor (not the opener's re-projected rect), so it
 * stays put while text above reflows; only its vertical span tracks the rects.
 */
const computeBands = (
  groups: DirectiveRectGroup[],
  contentLeft: number | null,
): Band[] => {
  const blocks = groups
    .filter(
      (g) => BLOCK_OPENERS.has(g.range.kind) || BLOCK_CLOSERS.has(g.range.kind),
    )
    .sort((a, b) => a.range.from - b.range.from);

  const bands: Band[] = [];
  const stack: { group: DirectiveRectGroup; depth: number }[] = [];
  for (const group of blocks) {
    if (BLOCK_OPENERS.has(group.range.kind)) {
      stack.push({ group, depth: stack.length });
      continue;
    }
    const open = stack.pop();
    const openerRect = open?.group.rects[0];
    const closerRect = group.rects[0];
    if (!open || !openerRect || !closerRect) {
      continue;
    }
    const railBase = contentLeft ?? openerRect.x;
    bands.push({
      top: openerRect.y,
      bottom: closerRect.y + closerRect.height,
      railX: railBase - RAIL_BASE_GUTTER + open.depth * RAIL_DEPTH_GAP,
    });
  }
  return bands;
};

export const TemplateDirectivesOverlay = ({
  groups,
  contentLeft,
}: TemplateDirectivesOverlayProps) => {
  if (groups.length === 0) {
    return null;
  }

  const bands = computeBands(groups, contentLeft);

  return (
    <div style={overlayStyles} data-folio-template-directives-overlay="">
      {bands.map((band, bandIdx) => (
        <div
          key={`rail:${bandIdx}`}
          className="folio-template-band-rail"
          style={{
            left: band.railX,
            top: band.top,
            width: RAIL_WIDTH,
            height: Math.max(0, band.bottom - band.top),
          }}
        />
      ))}

      {groups.flatMap(({ range, rects }, groupIdx) =>
        rects.map((rect, idx) => (
          <span
            key={`d:${groupIdx}:${idx}`}
            className={`folio-template-directive folio-template-directive--${range.kind}`}
            style={{
              left: rect.x - 1,
              top: rect.y + 1,
              width: rect.width + 2,
              height: Math.max(0, rect.height - 2),
            }}
          />
        )),
      )}
    </div>
  );
};
