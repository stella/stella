/**
 * Selection Overlay Component
 *
 * Renders the selection overlay for the paged editor, including:
 * - Caret cursor (blinking vertical line for collapsed selection)
 * - Selection highlights (blue rectangles for range selection)
 *
 * The overlay is positioned absolutely over the pages container and
 * renders selection rectangles in container-relative coordinates.
 */

import React, { useEffect, useState } from "react";

import type {
  SelectionRect,
  CaretPosition,
} from "../core/layout-bridge/selectionRects";
import type { Layout, FlowBlock, Measure } from "../core/layout-engine/types";
import "../styles/editor.css";

// =============================================================================
// TYPES
// =============================================================================

export type SelectionOverlayProps = {
  /** Selection rectangles for range selection. */
  selectionRects: SelectionRect[];
  /** Caret position for collapsed selection. */
  caretPosition: CaretPosition | null;
  /** Whether the editor is focused. */
  isFocused: boolean;
  /** Gap between pages (for coordinate adjustment). */
  pageGap?: number;
  /** Custom caret color. */
  caretColor?: string;
  /** Custom selection background color. */
  selectionColor?: string;
  /** Caret width in pixels. */
  caretWidth?: number;
  /** Blink interval in milliseconds (0 to disable). */
  blinkInterval?: number;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CARET_COLOR = "var(--doc-canvas-text, #000)";
const DEFAULT_SELECTION_COLOR = "var(--doc-selection, rgba(66, 133, 244, 0.3))";
const DEFAULT_CARET_WIDTH = 2;
const DEFAULT_BLINK_INTERVAL = 530; // Standard cursor blink rate

// =============================================================================
// STYLES
// =============================================================================

const overlayStyles: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: "50%",
  width: "100vw",
  bottom: 0,
  transform: "translateX(-50%)",
  pointerEvents: "none",
  zIndex: 10,
  overflow: "visible",
};

const caretStyles = (
  caret: CaretPosition,
  color: string,
  width: number,
  isFocused: boolean,
  blinkInterval: number,
): React.CSSProperties => ({
  position: "absolute",
  left: caret.x,
  top: caret.y,
  width,
  height: caret.height,
  backgroundColor: color,
  // Solid when focused; the animation (when blinking is enabled) takes over
  // the opacity. `blinkInterval === 0` keeps the caret solid with no blink.
  opacity: isFocused ? 1 : 0,
  animation:
    isFocused && blinkInterval > 0
      ? `folio-caret-blink ${blinkInterval * 2}ms steps(1, end) infinite`
      : undefined,
  pointerEvents: "none",
});

const selectionRectStyles = (
  rect: SelectionRect,
  color: string,
): React.CSSProperties => ({
  position: "absolute",
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
  backgroundColor: color,
  pointerEvents: "none",
});

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Caret component.
 *
 * The blink is a pure CSS animation (`folio-caret-blink`), so the cursor
 * never drives React state updates while it blinks. The parent remounts this
 * component — keyed on caret position — after typing or navigation, which
 * restarts the animation from its solid phase so the caret shows immediately.
 */
const Caret: React.FC<{
  position: CaretPosition;
  color: string;
  width: number;
  blinkInterval: number;
  isFocused: boolean;
}> = ({ position, color, width, blinkInterval, isFocused }) => (
  <div
    style={caretStyles(position, color, width, isFocused, blinkInterval)}
    data-testid="caret"
  />
);

/**
 * Selection rectangle component.
 */
const SelectionRectangle: React.FC<{
  rect: SelectionRect;
  color: string;
  index: number;
}> = ({ rect, color, index }) => (
  <div
    style={selectionRectStyles(rect, color)}
    data-testid={`selection-rect-${index}`}
    data-page-index={rect.pageIndex}
  />
);

/**
 * Selection overlay component.
 *
 * Renders selection highlights and caret cursor over the paginated document.
 * Should be positioned as a child of the pages container with relative positioning.
 */
export const SelectionOverlay: React.FC<SelectionOverlayProps> = ({
  selectionRects,
  caretPosition,
  isFocused,
  caretColor = DEFAULT_CARET_COLOR,
  selectionColor = DEFAULT_SELECTION_COLOR,
  caretWidth = DEFAULT_CARET_WIDTH,
  blinkInterval = DEFAULT_BLINK_INTERVAL,
}) => {
  // Determine if we have a range selection or collapsed selection
  const hasRangeSelection = selectionRects.length > 0;
  const hasCollapsedSelection = caretPosition !== null && !hasRangeSelection;

  return (
    <div style={overlayStyles} data-testid="selection-overlay">
      {/* Render selection rectangles for range selection */}
      {hasRangeSelection &&
        selectionRects.map((rect, index) => (
          <SelectionRectangle
            key={`sel-${rect.pageIndex}-${rect.x}-${rect.y}-${index}`}
            rect={rect}
            color={selectionColor}
            index={index}
          />
        ))}

      {/* Render caret for collapsed selection. The `key` remounts the caret
          when it moves, restarting the CSS blink from its visible phase. */}
      {hasCollapsedSelection && (
        <Caret
          key={`${caretPosition.x}-${caretPosition.y}-${caretPosition.height}`}
          position={caretPosition}
          color={caretColor}
          width={caretWidth}
          blinkInterval={blinkInterval}
          isFocused={isFocused}
        />
      )}
    </div>
  );
};

// =============================================================================
// HELPER HOOKS
// =============================================================================

/**
 * Hook to manage selection overlay state.
 *
 * @param pmSelection - ProseMirror selection {from, to}.
 * @param layout - Document layout.
 * @param blocks - Flow blocks.
 * @param measures - Measurements.
 * @returns Selection overlay props.
 */
export function useSelectionOverlay(
  pmSelection: { from: number; to: number } | null,
  layout: Layout | null,
  blocks: FlowBlock[],
  measures: Measure[],
): {
  selectionRects: SelectionRect[];
  caretPosition: CaretPosition | null;
} {
  const [selectionRects, setSelectionRects] = useState<SelectionRect[]>([]);
  const [caretPosition, setCaretPosition] = useState<CaretPosition | null>(
    null,
  );

  useEffect(() => {
    if (!layout || !pmSelection) {
      setSelectionRects([]);
      setCaretPosition(null);
      return;
    }

    // Import dynamically to avoid circular dependencies
    void import("../core/layout-bridge/selectionRects").then(
      ({ selectionToRects, getCaretPosition }) => {
        const { from, to } = pmSelection;

        if (from === to) {
          // Collapsed selection - show caret
          const caret = getCaretPosition(layout, blocks, measures, from);
          setCaretPosition(caret);
          setSelectionRects([]);
        } else {
          // Range selection - show highlight
          const rects = selectionToRects(layout, blocks, measures, from, to);
          setSelectionRects(rects);
          setCaretPosition(null);
        }
        return;
      },
    );
  }, [pmSelection, layout, blocks, measures]);

  return { selectionRects, caretPosition };
}
