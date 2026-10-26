import { describe, expect, test } from "bun:test";

import { apiRoutes } from "@/api/api-routes";
import type { ApiRouteKey } from "@/api/http/api-route-types";
import type { RouteAccess, RouteDefinition } from "@/api/http/route";
import {
  ACCOUNT_ACCESS,
  getSafeHandlerAccountAccess,
} from "@/api/lib/api-handlers";
import {
  MCP_MODES,
  MCP_RESOURCE_MODE_CONFIG,
} from "@/api/mcp/resource-policy-contract";

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
const RAW_ROUTES: ReadonlyMap<ApiRouteKey, RawRouteReview> = new Map([
  [
    "GET /api/auth/*",
    {
      access: RAW_ROUTE_ACCESS.sandbox,
      reason:
        "Better Auth handler; its before hooks refuse the demo account's account, key, OAuth and organization writes.",
    },
  ],
  [
    "POST /api/auth/*",
    {
      access: RAW_ROUTE_ACCESS.sandbox,
      reason:
        "Better Auth handler; its before hooks refuse the demo account's account, key, OAuth and organization writes.",
    },
  ],
  ...MCP_MODES.flatMap((mode) =>
    (["GET", "POST", "DELETE"] as const).map(
      (method) =>
        [
          `${method} ${MCP_RESOURCE_MODE_CONFIG[mode].httpPath}` satisfies ApiRouteKey,
          {
            access: RAW_ROUTE_ACCESS.sessionless,
            reason:
              "MCP token transport; the demo account is refused once the token resolves.",
          },
        ] as const,
    ),
  ),
  ...MCP_MODES.map(
    (mode) =>
      [
        `OPTIONS ${MCP_RESOURCE_MODE_CONFIG[mode].httpPath}` satisfies ApiRouteKey,
        {
          access: RAW_ROUTE_ACCESS.sessionless,
          reason:
            "MCP transport preflight; answers any origin without credentials.",
        },
      ] as const,
  ),
  [
    "GET /mcp-app-sandbox",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public static sandbox document the web app frames.",
    },
  ],
  [
    "GET /visual-sandbox",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public static sandbox document the web app frames.",
    },
  ],
  [
    "GET /.well-known/openai-apps-challenge",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public static domain-verification token.",
    },
  ],
  [
    "GET /dev-public/last-otp",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "GET /health",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public health probe.",
    },
  ],
  [
    "GET /live",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public liveness probe.",
    },
  ],
  [
    "GET /oauth-ui/auth",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public redirect to the web sign-in page.",
    },
  ],
  [
    "GET /oauth-ui/auth/organization",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public redirect to the web organization picker.",
    },
  ],
  [
    "GET /oauth-ui/consent",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public redirect to the web consent page.",
    },
  ],
  [
    "GET /ready",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public readiness probe.",
    },
  ],
  [
    "GET /started",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public startup probe.",
    },
  ],
  [
    "GET /v1/auth/capabilities",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public list of the deployment's sign-in methods.",
    },
  ],
  [
    "GET /v1/desktop-edit-sessions/:sessionId/events",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Authorized by the desktop edit-session token.",
    },
  ],
  [
    "GET /v1/desktop-edit-sessions/:sessionId/status",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Authorized by the desktop edit-session token.",
    },
  ],
  [
    "GET /v1/dev/public-law-connection",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "GET /v1/dev/seed",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "GET /v1/dev/seed-firm-knowledge",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "GET /v1/notifications/events",
    {
      access: RAW_ROUTE_ACCESS.sandbox,
      reason: "Read-only event stream for the session's organization.",
    },
  ],
  [
    "GET /v1/verify/:code",
    {
      access: RAW_ROUTE_ACCESS.sandbox,
      reason:
        "Read-only verification-code lookup within the session's organization.",
    },
  ],
  [
    "GET /v1/workspaces/:workspaceId/events",
    {
      access: RAW_ROUTE_ACCESS.sandbox,
      reason:
        "Read-only event stream for a matter the session's member can access.",
    },
  ],
  [
    "OPTIONS /.well-known/oauth-authorization-server",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public discovery preflight.",
    },
  ],
  [
    "OPTIONS /.well-known/oauth-authorization-server/api/auth",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public discovery preflight.",
    },
  ],
  [
    "OPTIONS /.well-known/oauth-protected-resource",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public discovery preflight.",
    },
  ],
  ...MCP_MODES.map(
    (mode) =>
      [
        `OPTIONS ${MCP_RESOURCE_MODE_CONFIG[mode].discoveryPath}` satisfies ApiRouteKey,
        {
          access: RAW_ROUTE_ACCESS.sessionless,
          reason: "Public discovery preflight.",
        },
      ] as const,
  ),
  [
    "OPTIONS /.well-known/openid-configuration",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public discovery preflight.",
    },
  ],
  [
    "OPTIONS /auth.md",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public agent-auth manifest preflight.",
    },
  ],
  [
    "POST /public/feedback",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Public feedback intake, rate-limited per IP and deduplicated.",
    },
  ],
  [
    "GET /smoke/scheduled-jobs",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason:
        "Authorized by a shared secret and refused outside the staging deployment. Reads the scheduler's recent run records of fixed corpus jobs.",
    },
  ],
  [
    "POST /smoke/scheduled-jobs",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason:
        "Authorized by a shared secret and refused outside the staging deployment. Only moves fixed recurring corpus jobs' next run forward.",
    },
  ],
  [
    "POST /smoke/session",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason:
        "Authorized by a shared secret; inert unless the secret is configured.",
    },
  ],
  [
    "POST /synthetic/session",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason:
        "Authorized by a dedicated credential; inert unless the credential is configured.",
    },
  ],
  [
    "POST /usage/hosted/webhook",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Authorized by an HMAC signature over the raw body.",
    },
  ],
  [
    "POST /v1/desktop-edit-handoffs/:handoffId/opened",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Authorized by a desktop API key and the handoff token.",
    },
  ],
  [
    "POST /v1/desktop-edit-handoffs/redeem",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Authorized by a desktop API key and the handoff token.",
    },
  ],
  [
    "POST /v1/desktop-edit-sessions/:sessionId/checkpoint",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Authorized by the desktop edit-session token.",
    },
  ],
  [
    "POST /v1/desktop-edit-sessions/:sessionId/finalize",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Authorized by the desktop edit-session token.",
    },
  ],
  [
    "POST /v1/desktop-edit-sessions/:sessionId/respond-takeover",
    {
      access: RAW_ROUTE_ACCESS.sessionless,
      reason: "Authorized by the desktop edit-session token.",
    },
  ],
  [
    "POST /v1/dev/clean",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "POST /v1/dev/clear-cache",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "POST /v1/dev/public-law-connection",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "POST /v1/dev/rebuild-search",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "POST /v1/dev/seed",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
  [
    "POST /v1/dev/seed-firm-knowledge",
    {
      access: RAW_ROUTE_ACCESS.localDevelopment,
      reason: "Mounted and answered only while local development is open.",
    },
  ],
]);

/** How a route may be reached without a session: no caller, or its own credential. */
const SESSIONLESS_ACCESS: ReadonlySet<RouteAccess> = new Set([
  "public",
  "token",
]);

const routeLabel = ({ method, path }: { method: string; path: string }) =>
  `${method} ${path}`;

/** The safe factory's handler a definition carries, when a factory built it. */
const handlerOf = (definition: RouteDefinition): unknown =>
  "handler" in definition ? definition.handler : undefined;

const isSafeRoute = ({ definition }: { definition: RouteDefinition }) =>
  getSafeHandlerAccountAccess(handlerOf(definition)) !== undefined;

const reviewOf = (label: string): RawRouteReview | undefined =>
  [...RAW_ROUTES].find(([key]) => key === label)?.[1];

describe("raw route census", () => {
  test("every route outside the safe handlers is classified", () => {
    const safeRoutes = apiRoutes.filter(isSafeRoute);
    // The registry must see the factory-built routes, or a census that
    // recognized nothing would report every route as raw.
    expect(safeRoutes.length).toBeGreaterThan(100);

    const rawRoutes = apiRoutes
      .filter((route) => !isSafeRoute(route))
      .map((route) => routeLabel(route))
      .toSorted();

    expect(rawRoutes).toEqual([...RAW_ROUTES.keys()].toSorted());
  });

  test("a route classified sessionless never authenticates by session", () => {
    const sessionless = apiRoutes.filter(
      (route) =>
        reviewOf(routeLabel(route))?.access === RAW_ROUTE_ACCESS.sessionless,
    );
    expect(sessionless.length).toBeGreaterThan(0);
    expect(
      sessionless
        .filter((route) => !SESSIONLESS_ACCESS.has(route.definition.access))
        .map((route) => `${routeLabel(route)} (${route.definition.access})`),
    ).toEqual([]);
  });
});
