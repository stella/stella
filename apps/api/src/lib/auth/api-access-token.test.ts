import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { JWTPayload } from "jose";

import { MOBILE_SCOPES } from "@stll/api-contract/mobile-client";
import { assertProperty } from "@stll/property-testing";

import {
  admitApiAccessTokenRoute,
  API_OAUTH_ROUTES,
  authenticateApiAccessToken,
  readAccessTokenBearer,
} from "@/api/lib/auth/api-access-token";
import { getApiOAuthResourceIdentifier } from "@/api/lib/oauth-resource-policy";

const NO_REVIEW_ACCOUNT = { organizationId: undefined };

const USER_CLAIMS = {
  sub: "user-1",
  org_id: "org-1",
  member_id: "member-1",
  client_id:
    "https://api.example.test/v1/mcp/oauth/mobile-client-metadata.json",
  scope: "openid offline_access stella:read",
} satisfies JWTPayload;

/** A provider verifier that accepts any token and hands back `payload`. */
const verifierReturning =
  (payload: JWTPayload) =>
  async (_token: string | undefined, _options?: unknown): Promise<JWTPayload> =>
    await Promise.resolve(payload);

const authenticate = async (payload: JWTPayload) => {
  const result = await authenticateApiAccessToken("a.b.c", {
    reviewAccount: NO_REVIEW_ACCOUNT,
    verifyToken: verifierReturning(payload),
  });
  return result.isOk() ? result.value : { refused: result.error.reason };
};

describe("which bearer takes the access-token path", () => {
  test("only a three-segment JWT, so a signed session token keeps the session path", () => {
    const bearer = (value: string) =>
      readAccessTokenBearer(new Headers({ authorization: value }));
    expect(bearer("Bearer aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
    expect(bearer("bearer aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
    expect(bearer("Bearer session-token.signature")).toBeUndefined();
    expect(bearer("Bearer stella_mk_abc")).toBeUndefined();
    expect(bearer("Basic aaa.bbb.ccc")).toBeUndefined();
    expect(readAccessTokenBearer(new Headers())).toBeUndefined();
  });
});

describe("API access token claims", () => {
  test("a user grant for an app opens the session it was issued under", async () => {
    expect(await authenticate(USER_CLAIMS)).toEqual({
      userId: "user-1",
      organizationId: "org-1",
      memberId: "member-1",
      clientId: USER_CLAIMS.client_id,
      scopes: ["openid", "offline_access", "stella:read"],
    });
  });

  test("is verified for the REST API audience and nothing else", async () => {
    let audience: unknown;
    await authenticateApiAccessToken("a.b.c", {
      reviewAccount: NO_REVIEW_ACCOUNT,
      verifyToken: async (_token, options) => {
        audience = options.verifyOptions.audience;
        return await Promise.resolve(USER_CLAIMS);
      },
    });
    expect(audience).toBe(getApiOAuthResourceIdentifier());
  });

  test("a token without its membership, app or user is refused", async () => {
    for (const claim of ["member_id", "org_id", "sub", "client_id"] as const) {
      const { [claim]: _dropped, ...claims } = USER_CLAIMS;
      expect(await authenticate(claims)).toEqual({ refused: "rejected" });
    }
  });

  test("agent-run and service-client credentials are refused", async () => {
    expect(
      await authenticate({ ...USER_CLAIMS, purpose: "agent-run", run_id: "r" }),
    ).toEqual({ refused: "rejected" });
    expect(
      await authenticate({ ...USER_CLAIMS, stella_principal: "service" }),
    ).toEqual({ refused: "rejected" });
  });

  test("a verifier outage is not reported as a bad token", async () => {
    const result = await authenticateApiAccessToken("a.b.c", {
      reviewAccount: NO_REVIEW_ACCOUNT,
      verifyToken: async () => {
        throw new TypeError("JWKS fetch failed");
      },
    });
    expect(result.isErr() && result.error.reason).toBe("unavailable");
  });
});

describe("which routes an API access token opens", () => {
  test("a listed route with its scope is admitted", () => {
    for (const [key, { scope }] of Object.entries(API_OAUTH_ROUTES)) {
      const [method = "", route = ""] = key.split(" ");
      expect(
        admitApiAccessTokenRoute({ method, route, scopes: [scope] }),
      ).toEqual({ admitted: true });
      expect(admitApiAccessTokenRoute({ method, route, scopes: [] })).toEqual({
        admitted: false,
        reason: "scope",
      });
    }
  });

  test("a read grant opens the task list but not the writes beside it", () => {
    const readOnly = ["stella:read", "stella:chat"];
    expect(
      admitApiAccessTokenRoute({
        method: "GET",
        route: "/v1/tasks",
        scopes: readOnly,
      }),
    ).toEqual({ admitted: true });
    for (const [method, route] of [
      ["PUT", "/v1/workspaces"],
      ["PUT", "/v1/tasks/:workspaceId"],
    ] as const) {
      expect(
        admitApiAccessTokenRoute({ method, route, scopes: readOnly }),
      ).toEqual({ admitted: false, reason: "scope" });
      expect(
        admitApiAccessTokenRoute({
          method,
          route,
          scopes: ["stella:matters_write"],
        }),
      ).toEqual({ admitted: true });
    }
  });

  test("the mobile app asks for every scope a listed route requires", () => {
    const routeScopes = new Set(
      Object.values(API_OAUTH_ROUTES).map(({ scope }) => scope),
    );
    expect(
      [...routeScopes].filter((scope) => !MOBILE_SCOPES.includes(scope)),
    ).toEqual([]);
  });

  test("a request no route matched is refused", () => {
    expect(
      admitApiAccessTokenRoute({
        method: "GET",
        route: undefined,
        scopes: ["stella:read"],
      }),
    ).toEqual({ admitted: false, reason: "route" });
  });

  test("every unlisted route is refused whatever the token carries", () => {
    const listed = new Set(Object.keys(API_OAUTH_ROUTES));
    assertProperty(
      "every unlisted route is refused whatever the token carries",
      fc.property(
        fc.constantFrom("GET", "POST", "PUT", "PATCH", "DELETE", "ALL"),
        fc.oneof(
          fc.webPath(),
          fc.constantFrom(
            "/v1/workspaces/",
            "/v1/workspaces/:workspaceId",
            "/v1/tasks/",
            "/v1/tasks/:workspaceId",
            "/v1/tasks/:workspaceId/:taskId",
            "/v1/time-timers/admin",
            "/v1/time-timers/admin/:id/stop",
            "/v1/me/oauth-connections/:consentId",
            "/v1/contacts",
          ),
        ),
        fc.array(
          fc.constantFrom(
            "stella:read",
            "stella:matters_write",
            "stella:billing_write",
            "stella:admin_write",
            "openid",
          ),
        ),
        (method, route, scopes) => {
          fc.pre(!listed.has(`${method} ${route}`));
          expect(admitApiAccessTokenRoute({ method, route, scopes })).toEqual({
            admitted: false,
            reason: "route",
          });
        },
      ),
    );
  });
});
