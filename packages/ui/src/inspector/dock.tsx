import type { ReactNode } from "react";

import { EllipsisIcon } from "lucide-react";

import { SHELL_CHROME_LAYER_CLASS_NAME } from "../lib/overlay-layer";
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

/**
 * Where the dock hangs, which decides what its fixed pane has to paint above.
 * `shell-end` is the shell's own end column: it is a sibling of the content
 * column and never overlaps the sticky top bar. `content` is a dock a page
 * mounts inside that column; its pane still spans the full viewport height,
 * so it crosses the bar and has to cover it.
 */
export type InspectorDockMount = "content" | "shell-end";

const PANE_LAYER_CLASS_NAME = {
  content: SHELL_CHROME_LAYER_CLASS_NAME,
  "shell-end": "z-10",
} as const satisfies Record<InspectorDockMount, string>;

type InspectorDockProps = {
  children: ReactNode;
  className?: string | undefined;
  mount?: InspectorDockMount | undefined;
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
  mount = "shell-end",
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
        className={cn(
          "fixed inset-y-0 end-0 hidden h-svh md:flex",
          PANE_LAYER_CLASS_NAME[mount],
        )}
        data-slot="inspector-dock-pane"
        style={{ width: widthPx }}
      >
        {showPaneContent && (
          <div
            aria-label={resizeHandleLabel}
            className="group focus-visible:outline-primary absolute inset-y-0 -start-1.5 z-20 flex w-3 cursor-col-resize items-center justify-center focus-visible:outline-2"
            data-slot="inspector-resize-handle"
            role="separator"
            {...resizeHandleProps}
            // Kept literal, not merged in from the spread: the a11y lint
            // rules read static JSX, and a focusable separator is the whole
            // reason the handle is operable without a pointer.
            tabIndex={0}
            onDoubleClick={onResetWidth}
          >
            <span
              aria-hidden="true"
              className="bg-border group-hover:bg-primary group-active:bg-primary absolute inset-y-0 start-1/2 w-px -translate-x-1/2"
            />
            <span
              aria-hidden="true"
              className="bg-background/80 text-foreground-placeholder ring-border/60 group-hover:bg-accent group-hover:text-foreground group-focus-visible:bg-accent group-focus-visible:text-foreground relative flex h-5 w-3 items-center justify-center rounded-full opacity-0 shadow-xs ring-1 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100"
              data-slot="inspector-resize-grip"
            >
              <EllipsisIcon className="size-3 rotate-90" />
            </span>
          </div>
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
