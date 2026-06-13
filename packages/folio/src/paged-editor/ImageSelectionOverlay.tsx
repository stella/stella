/**
 * ImageSelectionOverlay Component
 *
 * Renders a selection overlay with resize handles over a selected image
 * in the visible pages. Handles:
 * - Blue selection border
 * - 4 corner handles (resize, keeping aspect ratio; Shift frees it)
 * - 4 edge handles (stretch one dimension, breaking aspect ratio)
 * - Dimension tooltip during resize
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import type { CSSProperties } from "react";

// =============================================================================
// TYPES
// =============================================================================

/**
 * An image resize handle: the 4 corners ("nw"/"ne"/"se"/"sw") resize both axes
 * and keep the aspect ratio (Shift frees it); the 4 edge midpoints
 * ("n"/"s"/"e"/"w") resize a single axis so the user can deliberately stretch
 * the image (break aspect).
 */
export type ResizeHandle = "nw" | "ne" | "se" | "sw" | "n" | "s" | "e" | "w";

export type ImageSelectionInfo = {
  /** The DOM element of the selected image in the pages container */
  element: HTMLElement;
  /** ProseMirror position of the image node */
  pmPos: number;
  /** Current width in pixels */
  width: number;
  /** Current height in pixels */
  height: number;
};

export type ImageSelectionOverlayProps = {
  /** Info about the currently selected image, or null if no image selected */
  imageInfo: ImageSelectionInfo | null;
  /** Zoom level */
  zoom: number;
  /** Whether the editor is focused */
  isFocused: boolean;
  /** Callback when image is resized */
  onResize?: (pmPos: number, newWidth: number, newHeight: number) => void;
  /** Callback when resize starts (to prevent other interactions) */
  onResizeStart?: () => void;
  /** Callback when resize ends */
  onResizeEnd?: () => void;
  /** Callback when image drag-move completes. Receives drop clientX/clientY. */
  onDragMove?: (pmPos: number, clientX: number, clientY: number) => void;
  /** Callback when drag starts */
  onDragStart?: () => void;
  /** Callback when drag ends (cancelled or completed) */
  onDragEnd?: () => void;
};

// =============================================================================
// STYLES
// =============================================================================

const HANDLE_SIZE = 10;
const HANDLE_HALF = HANDLE_SIZE / 2;
const BORDER_WIDTH = 2;
const IMAGE_SELECTION_COLOR = "var(--doc-image-selection)";
const DRAG_GHOST_SELECTION_VAR = "--image-drag-ghost-selection";
const DRAG_GHOST_SELECTION_MUTED_VAR = "--image-drag-ghost-selection-muted";

const overlayStyles: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  pointerEvents: "none",
  zIndex: 15,
  overflow: "visible",
};

const borderStyles: CSSProperties = {
  position: "absolute",
  border: `${BORDER_WIDTH}px solid ${IMAGE_SELECTION_COLOR}`,
  pointerEvents: "none",
  boxSizing: "border-box",
};

// White circular dots with a thin accent ring — matches the resize handles in
// Word / PowerPoint. Fill uses the background token (white in light mode), the
// ring uses the image-selection accent token.
const handleBaseStyles: CSSProperties = {
  position: "absolute",
  width: `${HANDLE_SIZE}px`,
  height: `${HANDLE_SIZE}px`,
  backgroundColor: "var(--doc-handle-border)",
  border: `1.5px solid ${IMAGE_SELECTION_COLOR}`,
  borderRadius: "50%",
  boxShadow: "0 1px 3px var(--doc-shadow-md)",
  boxSizing: "border-box",
  pointerEvents: "auto",
  zIndex: 16,
};

const dimensionStyles: CSSProperties = {
  position: "absolute",
  backgroundColor: "var(--doc-dimension-bg)",
  color: "var(--doc-dimension-text)",
  fontSize: "11px",
  fontFamily: "system-ui, sans-serif",
  padding: "2px 8px",
  borderRadius: "3px",
  whiteSpace: "nowrap",
  pointerEvents: "none",
  zIndex: 20,
  transform: "translateX(-50%)",
};

const HANDLE_CURSORS = {
  nw: "nw-resize",
  ne: "ne-resize",
  se: "se-resize",
  sw: "sw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
} as const satisfies Record<ResizeHandle, string>;

// Handle positions as fractions of the box: 0 = start edge, 0.5 = midpoint,
// 1 = end edge. Corners drive both axes; edge midpoints drive one.
const HANDLES = [
  { pos: "nw", x: 0, y: 0 },
  { pos: "ne", x: 1, y: 0 },
  { pos: "se", x: 1, y: 1 },
  { pos: "sw", x: 0, y: 1 },
  { pos: "n", x: 0.5, y: 0 },
  { pos: "s", x: 0.5, y: 1 },
  { pos: "e", x: 1, y: 0.5 },
  { pos: "w", x: 0, y: 0.5 },
] as const satisfies readonly { pos: ResizeHandle; x: number; y: number }[];

// =============================================================================
// RESIZE CALCULATION
// =============================================================================

const MIN_IMAGE_PX = 20;
const MAX_IMAGE_PX = 2000;

/**
 * New image dimensions for a resize drag. Corner handles drive both axes; with
 * `lockAspect` (the default; Shift frees it) the resize follows the dominant
 * drag axis — the one whose scale moved furthest from 1 — so a corner drag that
 * mostly shrinks one side actually shrinks the image instead of snapping back to
 * the axis that barely moved. The scale is clamped as a whole so the aspect
 * ratio survives the min/max pixel bounds. Edge handles drive a single axis and
 * never lock; the non-driven axis passes through unchanged and unclamped.
 */
export function calculateNewDimensions(
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  startWidth: number,
  startHeight: number,
  lockAspect: boolean,
): { width: number; height: number } {
  const drivesWidth = handle.includes("w") || handle.includes("e");
  const drivesHeight = handle.includes("n") || handle.includes("s");
  const isCorner = drivesWidth && drivesHeight;

  const signX = handle.includes("w") ? -1 : 1;
  const signY = handle.includes("n") ? -1 : 1;

  const clamp = (n: number) =>
    Math.max(MIN_IMAGE_PX, Math.min(MAX_IMAGE_PX, n));

  if (isCorner && lockAspect) {
    const scaleX =
      startWidth > 0 ? (startWidth + deltaX * signX) / startWidth : 1;
    const scaleY =
      startHeight > 0 ? (startHeight + deltaY * signY) / startHeight : 1;
    let scale = Math.abs(scaleX - 1) > Math.abs(scaleY - 1) ? scaleX : scaleY;

    // Clamp the scale itself (not each dimension) so neither side can drift off
    // the aspect ratio when it hits MIN/MAX before the other. maxScale is
    // applied last so an extreme aspect ratio whose min-size and max-size
    // constraints cannot both hold (minScale > maxScale, e.g. a 700x1 rule)
    // caps at MAX_IMAGE_PX instead of running away past it.
    const minScale = Math.max(
      startWidth > 0 ? MIN_IMAGE_PX / startWidth : 0,
      startHeight > 0 ? MIN_IMAGE_PX / startHeight : 0,
    );
    const maxScale = Math.min(
      startWidth > 0 ? MAX_IMAGE_PX / startWidth : Infinity,
      startHeight > 0 ? MAX_IMAGE_PX / startHeight : Infinity,
    );
    scale = Math.min(maxScale, Math.max(minScale, scale));

    return { width: startWidth * scale, height: startHeight * scale };
  }

  return {
    width: drivesWidth ? clamp(startWidth + deltaX * signX) : startWidth,
    height: drivesHeight ? clamp(startHeight + deltaY * signY) : startHeight,
  };
}

function applyDragGhostTheme(
  ghostEl: HTMLElement,
  sourceEl: HTMLElement | null,
): void {
  const themeRoot = sourceEl?.closest(".folio-root") ?? sourceEl;

  if (!themeRoot) {
    return;
  }

  const probe = document.createElement("div");
  probe.style.borderColor = IMAGE_SELECTION_COLOR;
  probe.style.backgroundColor = "var(--doc-image-selection-muted)";
  themeRoot.append(probe);

  const computedStyles = window.getComputedStyle(probe);
  ghostEl.style.setProperty(
    DRAG_GHOST_SELECTION_VAR,
    computedStyles.borderColor,
  );
  ghostEl.style.setProperty(
    DRAG_GHOST_SELECTION_MUTED_VAR,
    computedStyles.backgroundColor,
  );
  probe.remove();
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ImageSelectionOverlay({
  imageInfo,
  zoom,
  isFocused,
  onResize,
  onResizeStart,
  onResizeEnd,
  onDragMove,
  onDragStart,
  onDragEnd,
}: ImageSelectionOverlayProps): React.ReactElement | null {
  const [isResizing, setIsResizing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [resizeWidth, setResizeWidth] = useState(0);
  const [resizeHeight, setResizeHeight] = useState(0);
  const [overlayRect, setOverlayRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const rafRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Store callbacks in refs so imperative handlers always have latest values
  const onResizeRef = useRef(onResize);
  const onResizeStartRef = useRef(onResizeStart);
  const onResizeEndRef = useRef(onResizeEnd);
  const onDragMoveRef = useRef(onDragMove);
  const onDragStartRef = useRef(onDragStart);
  const onDragEndRef = useRef(onDragEnd);
  onResizeRef.current = onResize;
  onResizeStartRef.current = onResizeStart;
  onResizeEndRef.current = onResizeEnd;
  onDragMoveRef.current = onDragMove;
  onDragStartRef.current = onDragStart;
  onDragEndRef.current = onDragEnd;

  // Store imageInfo and zoom in refs for the imperative mousemove/mouseup handlers
  const imageInfoRef = useRef(imageInfo);
  const zoomRef = useRef(zoom);
  imageInfoRef.current = imageInfo;
  zoomRef.current = zoom;

  // Update overlay position when imageInfo or layout changes
  const updatePosition = useCallback(() => {
    if (!imageInfo || !overlayRef.current) {
      setOverlayRect(null);
      return;
    }

    // Use the overlay's own offsetParent (the viewport div) for correct coordinates
    const offsetParent = overlayRef.current.offsetParent;
    if (!(offsetParent instanceof HTMLElement)) {
      setOverlayRect(null);
      return;
    }
    const parent = offsetParent;

    const parentRect = parent.getBoundingClientRect();
    const imageRect = imageInfo.element.getBoundingClientRect();

    // Calculate position relative to the overlay's positioning parent
    setOverlayRect({
      left: (imageRect.left - parentRect.left) / zoom,
      top: (imageRect.top - parentRect.top) / zoom,
      width: imageRect.width / zoom,
      height: imageRect.height / zoom,
    });
  }, [imageInfo, zoom]);

  // Update position on mount and when dependencies change
  useEffect(() => {
    updatePosition();
  }, [updatePosition]);

  // Also update on scroll/resize
  useEffect(() => {
    if (!imageInfo) {
      return;
    }

    const container =
      overlayRef.current?.closest('[style*="overflow"]') ??
      overlayRef.current?.closest(".paged-editor__container");
    if (!container) {
      return;
    }

    const handleScrollOrResize = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(updatePosition);
    };

    container.addEventListener("scroll", handleScrollOrResize, {
      passive: true,
    });
    window.addEventListener("resize", handleScrollOrResize, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleScrollOrResize);
      window.removeEventListener("resize", handleScrollOrResize);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [imageInfo, updatePosition]);

  // Handle resize start - registers window listeners IMMEDIATELY (not via useEffect)
  // This is critical because browser automation and fast interactions fire
  // mousedown/mousemove/mouseup synchronously before React can re-render.
  const handleResizeStart = useCallback(
    (handle: ResizeHandle, e: React.MouseEvent) => {
      if (!imageInfo || !overlayRect) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const startWidth = overlayRect.width;
      const startHeight = overlayRect.height;
      const startX = e.clientX;
      const startY = e.clientY;

      // Track final dimensions in local variables (no stale closure issues)
      let finalWidth = Math.round(startWidth);
      let finalHeight = Math.round(startHeight);

      setIsResizing(true);
      setResizeWidth(finalWidth);
      setResizeHeight(finalHeight);
      onResizeStartRef.current?.();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const currentZoom = zoomRef.current;
        const deltaX = (moveEvent.clientX - startX) / currentZoom;
        const deltaY = (moveEvent.clientY - startY) / currentZoom;
        const lockAspect = !moveEvent.shiftKey;

        const dims = calculateNewDimensions(
          handle,
          deltaX,
          deltaY,
          startWidth,
          startHeight,
          lockAspect,
        );

        finalWidth = Math.round(dims.width);
        finalHeight = Math.round(dims.height);
        setResizeWidth(finalWidth);
        setResizeHeight(finalHeight);

        // Update overlay rect for live preview
        setOverlayRect((prev) => {
          if (!prev) {
            return prev;
          }
          const newRect = { ...prev };
          if (handle.includes("w")) {
            newRect.left = prev.left + (prev.width - dims.width);
          }
          if (handle.includes("n")) {
            newRect.top = prev.top + (prev.height - dims.height);
          }
          newRect.width = dims.width;
          newRect.height = dims.height;
          return newRect;
        });
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);

        setIsResizing(false);

        // Use the locally tracked final dimensions (always up to date)
        const info = imageInfoRef.current;
        if (info) {
          onResizeRef.current?.(info.pmPos, finalWidth, finalHeight);
        }
        onResizeEndRef.current?.();
      };

      // Register listeners IMMEDIATELY - not in a useEffect
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [imageInfo, overlayRect],
  );

  // Handle drag-to-move: mousedown on image body (not a handle) starts a move drag
  const handleBodyMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!imageInfo || !overlayRect) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const DRAG_THRESHOLD = 4; // px before considering it a drag
      const startX = e.clientX;
      const startY = e.clientY;
      let dragStarted = false;
      let ghostEl: HTMLElement | null = null;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        if (!dragStarted && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          return; // Haven't moved enough to start dragging
        }

        if (!dragStarted) {
          dragStarted = true;
          setIsDragging(true);
          onDragStartRef.current?.();

          // Create ghost element
          ghostEl = document.createElement("div");
          ghostEl.className = "image-drag-ghost";
          applyDragGhostTheme(ghostEl, overlayRef.current);
          ghostEl.style.width = `${overlayRect.width}px`;
          ghostEl.style.height = `${overlayRect.height}px`;
          document.body.append(ghostEl);
        }

        if (ghostEl) {
          ghostEl.style.left = `${moveEvent.clientX - overlayRect.width / 2}px`;
          ghostEl.style.top = `${moveEvent.clientY - overlayRect.height / 2}px`;
        }
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);

        if (ghostEl) {
          ghostEl.remove();
          ghostEl = null;
        }

        setIsDragging(false);

        if (dragStarted) {
          const info = imageInfoRef.current;
          if (info) {
            onDragMoveRef.current?.(
              info.pmPos,
              upEvent.clientX,
              upEvent.clientY,
            );
          }
          onDragEndRef.current?.();
        }
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [imageInfo, overlayRect],
  );

  // Always render the container div so the ref is available for position calculation.
  // Use visibility:hidden when not active (keeps offsetParent accessible).
  const showOverlay = !!(imageInfo && overlayRect && isFocused);

  if (!showOverlay) {
    return (
      <div
        ref={overlayRef}
        style={{ ...overlayStyles, visibility: "hidden" }}
        className="image-selection-overlay"
      />
    );
  }

  const { left, top, width, height } = overlayRect;

  return (
    <div
      ref={overlayRef}
      style={overlayStyles}
      className="image-selection-overlay"
    >
      {/* Selection border */}
      <div
        style={{
          ...borderStyles,
          left: left - BORDER_WIDTH,
          top: top - BORDER_WIDTH,
          width: width + BORDER_WIDTH * 2,
          height: height + BORDER_WIDTH * 2,
        }}
      />

      {/* Draggable body area - click and drag to move */}
      <div
        role="presentation"
        style={{
          position: "absolute",
          left,
          top,
          width,
          height,
          cursor: isDragging ? "grabbing" : "grab",
          pointerEvents: "auto",
          zIndex: 15,
        }}
        onMouseDown={handleBodyMouseDown}
      />

      {/* 4 corner handles (keep aspect) + 4 edge handles (stretch one axis).
          x/y are fractions of the box: 0 = start edge, 0.5 = midpoint, 1 = end. */}
      {HANDLES.map(({ pos, x, y }) => (
        <Handle
          key={pos}
          handle={pos}
          style={{
            left: left + width * x - HANDLE_HALF,
            top: top + height * y - HANDLE_HALF,
          }}
          onMouseDown={handleResizeStart}
        />
      ))}

      {/* Dimension indicator during resize */}
      {isResizing && (
        <div
          style={{
            ...dimensionStyles,
            left: left + width / 2,
            top: top + height + 12,
          }}
        >
          {resizeWidth} × {resizeHeight}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// HANDLE SUB-COMPONENT
// =============================================================================

type HandleProps = {
  handle: ResizeHandle;
  style: CSSProperties;
  onMouseDown: (handle: ResizeHandle, e: React.MouseEvent) => void;
};

function Handle({
  handle,
  style,
  onMouseDown,
}: HandleProps): React.ReactElement {
  return (
    <div
      role="presentation"
      style={{
        ...handleBaseStyles,
        ...style,
        cursor: HANDLE_CURSORS[handle],
      }}
      onMouseDown={(e) => onMouseDown(handle, e)}
      data-handle={handle}
    />
  );
}
