import { describe, expect, test } from "bun:test";

import {
  ACCOUNT_ACCESS,
  getSafeHandlerAccountAccess,
} from "@/api/lib/api-handlers";
import api from "@/api/server";

/**
 * How a route outside the safe handler factories treats the demo account.
 * Safe handlers declare `accountAccess` in their config; a raw route has no
 * config, so its decision is recorded here.
 */
const RAW_ROUTE_ACCESS = {
  /** Authenticates without a session (public, signed, token or service
   *  bearer), so a session grants nothing an anonymous caller lacks. */
  sessionless: "sessionless",
  /** Reached with a session and admits the demo account. */
  sandbox: ACCOUNT_ACCESS.sandbox,
  /** Mounted only for local development. */
  localDevelopment: "local-development",
} as const;

type RawRouteAccess = (typeof RAW_ROUTE_ACCESS)[keyof typeof RAW_ROUTE_ACCESS];

type RawRouteReview = { access: RawRouteAccess; reason: string };

/**
 * Every mounted route whose handler no safe factory produced, keyed by
 * `METHOD path`. A new raw route fails the census until it is classified
 * here with a reason; an entry whose route is gone fails it too.
 */
const RAW_ROUTES = {} as const satisfies Record<string, RawRouteReview>;

const routeLabel = ({ method, path }: { method: string; path: string }) =>
  `${method} ${path}`;

describe("raw route census", () => {
  test("every route outside the safe handlers is classified", () => {
    const safeRoutes = api.routes.filter(
      (route) => getSafeHandlerAccountAccess(route.handler) !== undefined,
    );
    // The registry must see the factory-built routes, or a census that
    // recognized nothing would report every route as raw.
    expect(safeRoutes.length).toBeGreaterThan(100);

    const rawRoutes = api.routes
      .filter(
        (route) => getSafeHandlerAccountAccess(route.handler) === undefined,
      )
      .map((route) => routeLabel(route))
      .toSorted();

    expect(rawRoutes).toEqual(Object.keys(RAW_ROUTES).toSorted());
  });
});
