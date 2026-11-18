import type { ReactNode } from "react";

import { Navigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { AnyRoute, RouteComponent } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import type { FileRouteTypes } from "@/routeTree.gen";

/*
 * The pending-view contract. A page route's loading view is its own page in
 * a pending phase, from two sibling modules:
 *
 * - `-x.pending.tsx` exports the page's shell (its layout, with slots for
 *   what waits on data) and `XPending`, the shell with the paired pending
 *   pieces in those slots. It is context-free: the server paints it on a
 *   cold load before any provider mounts, so it reads no query, store, route
 *   API or app context; labels go through `PendingText`, which shows the
 *   text where the app's intl is mounted and a bar on the label's line where
 *   it is not. Static chrome is real (headings, greeting, toolbars, from
 *   light presentational faces); data regions use the pending piece that
 *   lives in the same module as the row, section or box it stands in for
 *   (`LandingRows` beside `LandingRowsPending`), never a bare `Skeleton`.
 * - `-x.page.tsx` exports `XPage`, which renders that same shell with the
 *   real content in its slots, so the two cannot drift.
 *
 * The route file imports both: `component: XPage, pendingComponent:
 * XPending`. The bundler splits the page into its own chunk (listed in the
 * manifest, so it is preloaded), and the pending half stays in the entry
 * chunk, which is why everything it imports must stay small. The
 * `route-pending-component` lint rules hold all of this.
 *
 * Route navigations render `XPending` in place; the cold-load frame renders
 * the leaf route's pending view as its body (`LeafPendingView`), so a reload
 * paints the page's shape from the first frame. `DefaultPendingComponent` is
 * the frame's last resort, never a page's pending view.
 */

/**
 * Which phase of its page a component renders, for a page that draws both
 * from one component: `pending` is the page the URL describes before its
 * data has arrived, `loaded` is that page with its data.
 */
export type RouteState = "pending" | "loaded";

type RedirectRouteComponent = RouteComponent & {
  /** The route this one sends every visitor to. */
  readonly redirectTarget: string;
};

const hasRedirectTarget = (
  component: unknown,
): component is RedirectRouteComponent =>
  typeof component === "function" &&
  "redirectTarget" in component &&
  typeof component.redirectTarget === "string";

const isRoute = (value: unknown): value is AnyRoute =>
  typeof value === "object" &&
  value !== null &&
  "options" in value &&
  "isRoot" in value;

// The router types its route map by the generated ids, so it is read here as
// the plain object it is at runtime.
const routeById = (routesById: object, id: string): AnyRoute | undefined => {
  const route: unknown = Reflect.get(routesById, id);
  return isRoute(route) ? route : undefined;
};

const routeByPath = (
  routesById: object,
  path: string,
): AnyRoute | undefined => {
  for (const candidate of Object.values(routesById)) {
    const route: unknown = candidate;
    if (isRoute(route) && (route.fullPath === path || route.to === path)) {
      return route;
    }
  }
  return undefined;
};

const MAX_REDIRECT_HOPS = 4;

/**
 * The pending view of the page the matched routes lead to: the leaf route's
 * own `pendingComponent`, or, for a route that only redirects, its target's.
 * The root never counts (its pending view is the frame), and neither does a
 * layout's delegation to its leaf.
 */
const leafPendingView = (
  routesById: object,
  matches: readonly { routeId: string }[],
): RouteComponent | undefined => {
  const leaf = matches.at(-1);
  let route =
    leaf === undefined ? undefined : routeById(routesById, leaf.routeId);
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    if (route === undefined || route.isRoot) {
      return undefined;
    }
    const { component, pendingComponent } = route.options;
    if (hasRedirectTarget(component)) {
      route = routeByPath(routesById, component.redirectTarget);
      continue;
    }
    return pendingComponent === LeafPendingView ? undefined : pendingComponent;
  }
  return undefined;
};

/** The matched page's pending view (`leafPendingView`), for a frame that
 *  draws it inside its own chrome. */
export const useLeafPendingView = (): RouteComponent | undefined => {
  const router = useRouter();
  return useRouterState({
    select: (state) => leafPendingView(router.routesById, state.matches),
  });
};

/**
 * Renders the leaf page's pending view wherever a pending view is drawn
 * above it: the cold-load frame's body, a redirect on its way, and a layout
 * route's pending view (`pendingComponent: LeafPendingView`). TanStack shows
 * the pending view of whichever match is pending, so without this a layout
 * that loads its own data would hide its page's shape behind a generic block.
 */
export function LeafPendingView({ fallback }: { fallback?: ReactNode }) {
  const view = useLeafPendingView();
  if (view === undefined) {
    return fallback ?? <DefaultPendingComponent />;
  }
  return <PendingViewOf view={view} />;
}

/** Renders a route's pending view: a component the route declared, not one
 *  made during render. */
const PendingViewOf = ({ view: View }: { view: RouteComponent }) => <View />;

/**
 * The component of a route whose only job is to send the visitor to another
 * route. It names its target, and while the navigation runs it shows the
 * target's pending view, so the redirect is no blank step on the way in.
 * The `route-pending-component` rule accepts it in place of a page.
 */
export const redirectRouteComponent = ({
  to,
}: {
  to: FileRouteTypes["to"];
}): RedirectRouteComponent => {
  const RedirectRoute = () => (
    <>
      <Navigate replace to={to} />
      <LeafPendingView />
    </>
  );
  return Object.assign(RedirectRoute, { redirectTarget: to });
};
