import type { RouteComponent } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- router static data uses declaration merging
  interface StaticDataRouteOption {
    /** The standalone pending frame needs translated labels to match its layout. */
    pendingText?: "request-locale";
  }
}

const FRAME_SAFE: unique symbol = Symbol("frame-safe pending view");

/**
 * A pending view that keeps the pending-view contract
 * (`routes/-route-pending-view.tsx`): context-free, so the cold-load frame
 * may render it before any provider mounts. Only a view marked so is drawn
 * as the frame's body; any other route's pending view still renders where
 * TanStack shows it, inside the providers, and the frame shows its generic
 * body for that route.
 */
type FramePendingView = RouteComponent & {
  readonly [FRAME_SAFE]: true;
};

export const framePendingView = (view: RouteComponent): FramePendingView =>
  Object.assign(view, { [FRAME_SAFE]: true as const });

export const isFramePendingView = (view: unknown): view is FramePendingView =>
  typeof view === "function" && FRAME_SAFE in view;
