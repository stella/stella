import type { RouteComponent } from "@tanstack/react-router";

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

/**
 * Pending timing for a route a matter's view switch lands on. The router's
 * default waits half a second before a pending view shows, keeping the
 * outgoing view on screen under the new address. These routes' pending views
 * are their pages' shapes, so one shows as soon as a load waits on the
 * network. The short wait spares a load answered from the cache, which
 * settles inside it: shown at zero, its pending view is rendered and thrown
 * away within the same transition, which only delays the page. No minimum: a
 * load that ends early swaps its content into the same shape instead of
 * holding the skeleton.
 */
export const VIEW_SWITCH_PENDING = { pendingMs: 50, pendingMinMs: 0 } as const;
