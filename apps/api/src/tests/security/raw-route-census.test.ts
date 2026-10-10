import { describe, expect, test } from "bun:test";

import {
  ACCOUNT_ACCESS,
  getSafeHandlerAccountAccess,
} from "@/api/lib/api-handlers";
import {
  MCP_MODES,
  MCP_RESOURCE_MODE_CONFIG,
} from "@/api/mcp/resource-policy-contract";
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
const RAW_ROUTES = {
  "ALL /*": {
    access: RAW_ROUTE_ACCESS.sandbox,
    reason:
      "Better Auth handler; its before hooks refuse the demo account's account, key, OAuth and organization writes.",
  },
  ...Object.fromEntries(
    MCP_MODES.map((mode) => [
      `ALL ${MCP_RESOURCE_MODE_CONFIG[mode].httpPath}`,
      {
        access: RAW_ROUTE_ACCESS.sessionless,
        reason:
          "MCP token transport; the demo account is refused once the token resolves.",
      },
    ]),
  ),
  "GET /.well-known/openai-apps-challenge": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public static domain-verification token.",
  },
  "GET /dev-public/last-otp": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "GET /health": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public health probe.",
  },
  "GET /live": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public liveness probe.",
  },
  "GET /oauth-ui/auth": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public redirect to the web sign-in page.",
  },
  "GET /oauth-ui/auth/organization": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public redirect to the web organization picker.",
  },
  "GET /oauth-ui/consent": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public redirect to the web consent page.",
  },
  "GET /ready": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public readiness probe.",
  },
  "GET /started": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public startup probe.",
  },
  "GET /v1/auth/capabilities": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public list of the deployment's sign-in methods.",
  },
  "GET /v1/desktop-edit-sessions/:sessionId/events": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Authorized by the desktop edit-session token.",
  },
  "GET /v1/desktop-edit-sessions/:sessionId/status": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Authorized by the desktop edit-session token.",
  },
  "GET /v1/dev/public-law-connection": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "GET /v1/dev/seed": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "GET /v1/dev/seed-firm-knowledge": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "GET /v1/notifications/events": {
    access: RAW_ROUTE_ACCESS.sandbox,
    reason: "Read-only event stream for the session's organization.",
  },
  "GET /v1/verify/:code": {
    access: RAW_ROUTE_ACCESS.sandbox,
    reason:
      "Read-only verification-code lookup within the session's organization.",
  },
  "GET /v1/workspaces/:workspaceId/events": {
    access: RAW_ROUTE_ACCESS.sandbox,
    reason:
      "Read-only event stream for a matter the session's member can access.",
  },
  "OPTIONS /": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "CORS preflight.",
  },
  "OPTIONS /*": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "CORS preflight.",
  },
  "OPTIONS /.well-known/oauth-authorization-server": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public discovery preflight.",
  },
  "OPTIONS /.well-known/oauth-authorization-server/api/auth": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public discovery preflight.",
  },
  "OPTIONS /.well-known/oauth-protected-resource": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public discovery preflight.",
  },
  ...Object.fromEntries(
    MCP_MODES.map((mode) => [
      `OPTIONS ${MCP_RESOURCE_MODE_CONFIG[mode].discoveryPath}`,
      {
        access: RAW_ROUTE_ACCESS.sessionless,
        reason: "Public discovery preflight.",
      },
    ]),
  ),
  "OPTIONS /.well-known/openid-configuration": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public discovery preflight.",
  },
  "OPTIONS /auth.md": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public agent-auth manifest preflight.",
  },
  "POST /agent/event/notify": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Rate-limited agent-auth event receiver; reads no session.",
  },
  "POST /public/feedback": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Public feedback intake, rate-limited per IP and deduplicated.",
  },
  "POST /smoke/session": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason:
      "Authorized by a shared secret; inert unless the secret is configured.",
  },
  "POST /usage/hosted/webhook": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Authorized by an HMAC signature over the raw body.",
  },
  "POST /v1/desktop-edit-handoffs/:handoffId/opened": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Authorized by a desktop API key and the handoff token.",
  },
  "POST /v1/desktop-edit-handoffs/redeem": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Authorized by a desktop API key and the handoff token.",
  },
  "POST /v1/desktop-edit-sessions/:sessionId/checkpoint": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Authorized by the desktop edit-session token.",
  },
  "POST /v1/desktop-edit-sessions/:sessionId/finalize": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Authorized by the desktop edit-session token.",
  },
  "POST /v1/desktop-edit-sessions/:sessionId/respond-takeover": {
    access: RAW_ROUTE_ACCESS.sessionless,
    reason: "Authorized by the desktop edit-session token.",
  },
  "POST /v1/dev/clean": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "POST /v1/dev/clear-cache": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "POST /v1/dev/public-law-connection": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "POST /v1/dev/rebuild-search": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "POST /v1/dev/seed": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
  "POST /v1/dev/seed-firm-knowledge": {
    access: RAW_ROUTE_ACCESS.localDevelopment,
    reason: "Mounted and answered only while local development is open.",
  },
} as const satisfies Record<string, RawRouteReview>;

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
