import type { ComponentType, ReactElement } from "react";

import { Navigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { AnyRoute, RouteComponent } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/default-pending";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";
import type { AppFrameScope } from "@/routes/-app-frame-scope";
import { isFramePendingView } from "@/routes/-pending-view.logic";
import type { FileRouteTypes } from "@/routeTree.gen";

/*
 * The pending-view contract. A page route's loading view is its own page in
 * a pending phase, from two sibling modules:
 *
 * - `-x.pending.tsx` exports the page's shell (its layout, with slots for
 *   what waits on data) and `XPending = framePendingView(...)`, the shell
 *   with the paired pending pieces in those slots; only a view marked so is
 *   drawn by the cold-load frame. It is context-free: the server paints it on a
 *   cold load before the app's providers mount, intl included (the client
 *   hydrates that paint before it restores the account's locale), so it
 *   reads no query, store, route API or app context; labels go
 *   through `PendingText`, which shows the text where the app's intl is
 *   mounted and a bar on the label's line where it is not. Static chrome is
 *   real (headings, greeting, toolbars, from
 *   light presentational faces); data regions use the pending piece that
 *   lives in the same module as the row, section or box it stands in for
 *   (`LandingRows` beside `LandingRowsPending`), never a bare `Skeleton`.
 * - `-x.page.tsx` exports `XPage`, which renders that same shell with the
 *   real content in its slots, so the two cannot drift.
 *
 * The route file imports both: `component: XPage, pendingComponent:
 * XPending`. The bundler splits the page into its own chunk (listed in the
 * manifest, so it is preloaded), and the pending half stays in the entry
 * chunk, which is why everything it imports must stay small (the startup
 * bundle gate caps each pending module). The `route-pending-component` lint
 * rules hold the pairing, and the context-free imports of a marked view; a
 * pending view that is not marked yet renders inside the providers, and the
 * frame shows its generic body for that route until it is.
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
 * The route whose page the matched routes lead to: the leaf, or, for a
 * route that only redirects, its target (through at most a few hops). The
 * root never counts: its pending view is the frame.
 */
const leafPageRoute = (
  routesById: object,
  matches: readonly { routeId: string }[],
): AnyRoute | undefined => {
  const leaf = matches.at(-1);
  let route =
    leaf === undefined ? undefined : routeById(routesById, leaf.routeId);
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    if (route === undefined || route.isRoot) {
      return undefined;
    }
    const { component } = route.options;
    if (!hasRedirectTarget(component)) {
      return route;
    }
    route = routeByPath(routesById, component.redirectTarget);
  }
  return undefined;
};

/**
 * The pending view of the page the matched routes lead to: the leaf route's
 * own `pendingComponent`, or, for a route that only redirects, its target's.
 * A layout's delegation to its leaf never counts.
 */
const leafPendingView = (
  routesById: object,
  matches: readonly { routeId: string }[],
): RouteComponent | undefined => {
  const pendingComponent = leafPageRoute(routesById, matches)?.options
    .pendingComponent;
  // Only a view that keeps the contract is safe before the providers.
  return isFramePendingView(pendingComponent) ? pendingComponent : undefined;
};

// A route's parent, which the router types loosely on a route read from its
// map; the root has none.
const parentOf = (route: AnyRoute): AnyRoute | undefined => {
  if (route.isRoot) {
    return undefined;
  }
  const parent: unknown = route.parentRoute;
  return isRoute(parent) ? parent : undefined;
};

const isAppFrameScope = (value: unknown): value is AppFrameScope =>
  Object.values(APP_FRAME_SCOPE).some((scope) => scope === value);

// The frame a route names in its static data, which the router types loosely
// on a route read from its map.
const frameScopeOf = (route: AnyRoute): AppFrameScope | undefined => {
  const staticData: unknown = route.options.staticData;
  if (typeof staticData !== "object" || staticData === null) {
    return undefined;
  }
  const scope: unknown = Reflect.get(staticData, "appFrame");
  return isAppFrameScope(scope) ? scope : undefined;
};

/**
 * For a leaf that only redirects, the frame of the page it leads to (the
 * nearest `appFrame` from that route up to the root), so the frame drawn
 * while the redirect runs is the one that page will have. `undefined` for a
 * leaf that renders its own page.
 */
export const leafRedirectFrameScope = (
  routesById: object,
  matches: readonly { routeId: string }[],
): AppFrameScope | undefined => {
  const leaf = matches.at(-1);
  const leafRoute =
    leaf === undefined ? undefined : routeById(routesById, leaf.routeId);
  if (
    leafRoute === undefined ||
    !hasRedirectTarget(leafRoute.options.component)
  ) {
    return undefined;
  }
  for (
    let route: AnyRoute | undefined = leafPageRoute(routesById, matches);
    route !== undefined;
    route = parentOf(route)
  ) {
    const scope = frameScopeOf(route);
    if (scope !== undefined) {
      return scope;
    }
  }
  return undefined;
};

/** `leafRedirectFrameScope` for the matched routes. */
export const useLeafRedirectFrameScope = (): AppFrameScope | undefined => {
  const router = useRouter();
  return useRouterState({
    select: (state) => leafRedirectFrameScope(router.routesById, state.matches),
  });
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
export function LeafPendingView({
  fallback,
}: {
  fallback?: ReactElement | undefined;
}): ReactElement {
  const view = useLeafPendingView();
  if (view === undefined) {
    return fallback ?? <DefaultPendingComponent />;
  }
  return <PendingViewOf view={view} />;
}

/** Renders a route's pending view: a component the route declared, not one
 *  made during render. */
export const PendingViewOf = ({ view: View }: { view: RouteComponent }) => (
  <View />
);

type RedirectRoute = {
  /** The route the visitor is sent to: its pending view (and its frame)
   *  stands while the navigation runs. */
  to: FileRouteTypes["to"];
  /**
   * Runs the navigation itself and renders nothing, for a target whose
   * params are made at the time (a new chat's id) or one a read decides
   * (the root, which sends a visitor without a session to sign in). Without
   * it, the route navigates to `to`.
   */
  navigator?: ComponentType | undefined;
};

/**
 * The component of a route whose only job is to send the visitor to another
 * route. It names its target, and while the navigation runs it shows the
 * target's pending view, so the redirect is no blank step on the way in.
 * The `route-pending-component` rule accepts it in place of a page.
 */
export const redirectRouteComponent = ({
  navigator: Navigator,
  to,
}: RedirectRoute): RedirectRouteComponent => {
  const RedirectRoute = () => (
    <>
      {Navigator === undefined ? <Navigate replace to={to} /> : <Navigator />}
      <LeafPendingView />
    </>
  );
  return Object.assign(RedirectRoute, { redirectTarget: to });
};
