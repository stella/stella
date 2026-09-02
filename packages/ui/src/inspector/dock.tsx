import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { INSPECTOR_RAIL_WIDTH } from "./pane-width";

/**
 * Docked inspector pane: an in-flow spacer plus a fixed overlay.
 *
 * The spacer is what makes the content column reflow: the pane itself is
 * `position: fixed`, so without a same-width sibling in the flow it would
 * cover the content instead of displacing it. Keeping the pane fixed
 * (rather than in the flow) is what lets it span the full viewport height
 * regardless of the topbar above the content.
 *
 * The root carries the reserved inline size itself rather than leaving it to
 * the spacer alone: a block-level root in a plain block host would otherwise
 * take the full containing width and push the content column off-screen,
 * which is exactly the failure the spacer exists to prevent. With the width
 * on the root, the dock reserves the same footprint in a flex row, a grid
 * track, or a plain block.
 *
 * The permanent rail sits on the pane's inline-start edge, the same order
 * the workspace inspector panel uses: collapsed, the rail is the whole dock
 * on the viewport edge; expanded, the pane opens beyond the rail, so the
 * rail keeps its place beside the content and its tabs and toggle stay next
 * to the pane they drive instead of jumping to the far edge of the screen.
 */

type InspectorResizeHandleProps = {
  "aria-orientation": "vertical";
  "aria-valuemax": number;
  "aria-valuemin": number;
  "aria-valuenow": number;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  tabIndex: number;
};

type InspectorDockProps = {
  children: ReactNode;
  className?: string | undefined;
  /** Permanent rail on the pane's inline-start edge, or by itself when collapsed. */
  rail?: ReactNode | undefined;
  /** Accessible name for the drag handle. */
  resizeHandleLabel: string;
  /** Handlers and ARIA state from `useInspectorPaneWidth`. */
  resizeHandleProps: InspectorResizeHandleProps;
  /** Double-click affordance restoring the default width. */
  onResetWidth?: (() => void) | undefined;
  /** Whether the full pane is shown, as opposed to the bare rail. */
  showPaneContent: boolean;
  /** Inline size the dock reserves, in CSS pixels. */
  width: number;
};

export const InspectorDock = ({
  children,
  className,
  onResetWidth,
  rail,
  resizeHandleLabel,
  resizeHandleProps,
  showPaneContent,
  width,
}: InspectorDockProps) => {
  const dockWidth =
    rail !== undefined && !showPaneContent ? INSPECTOR_RAIL_WIDTH : width;
  const widthPx = `${dockWidth}px`;

  return (
    <div
      className={cn(
        "text-sidebar-foreground hidden shrink-0 md:block",
        className,
      )}
      data-side="inline-end"
      data-slot="inspector-dock"
      data-state={showPaneContent ? "expanded" : "collapsed"}
      style={{ width: widthPx }}
    >
      {/* In-flow spacer: the content column reflows against this, not
          against the fixed pane. */}
      <div
        aria-hidden="true"
        className="bg-sidebar relative w-full"
        data-slot="inspector-dock-spacer"
      />
      <div
        className="fixed inset-y-0 end-0 z-10 hidden h-svh md:flex"
        data-slot="inspector-dock-pane"
        style={{ width: widthPx }}
      >
        {showPaneContent && (
          <div
            aria-label={resizeHandleLabel}
            className="hover:bg-border active:bg-border focus-visible:bg-primary focus-visible:outline-primary absolute inset-y-0 -start-px z-20 flex w-1 cursor-col-resize items-center justify-center border-s focus-visible:outline-2"
            data-slot="inspector-resize-handle"
            role="separator"
            {...resizeHandleProps}
            // Kept literal, not merged in from the spread: the a11y lint
            // rules read static JSX, and a focusable separator is the whole
            // reason the handle is operable without a pointer.
            tabIndex={0}
            onDoubleClick={onResetWidth}
          />
        )}
        {showPaneContent || rail === undefined ? (
          <div className="bg-sidebar flex h-full w-full flex-row">
            {rail}
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        ) : (
          rail
        )}
      </div>
    </div>
  );
};
