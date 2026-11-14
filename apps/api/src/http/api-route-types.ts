import type { apiRoutes } from "@/api/api-routes";
import type { HttpMethod, RoutesOf } from "@/api/http/route";

type ApiRoutes = RoutesOf<typeof apiRoutes>;

/** Full mounted path patterns, including runtime-conditional development routes. */
export type ApiRoutePath = keyof ApiRoutes;

/** A mounted method and path in the route censuses' spelling. */
export type ApiRouteKey = {
  [TPath in ApiRoutePath]: `${keyof ApiRoutes[TPath] & HttpMethod} ${TPath}`;
}[ApiRoutePath];
