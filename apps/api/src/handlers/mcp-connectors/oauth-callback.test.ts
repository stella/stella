import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import mcpOAuthCallback, {
  buildCallbackRedirectUrl,
  createMcpOAuthCallbackHandler,
} from "@/api/handlers/mcp-connectors/oauth-callback";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  getRequestId,
  initRequestContext,
} from "@/api/lib/observability/request-context";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("buildCallbackRedirectUrl", () => {
  test("encodes a connected slug onto the SPA terminal route", () => {
    const url = buildCallbackRedirectUrl("https://my.stll.app", {
      status: "connected",
      slug: "linear",
    });

    expect(url).toBe(
      "https://my.stll.app/mcp/oauth-callback?status=connected&slug=linear",
    );
  });

  test("encodes an error reason onto the SPA terminal route", () => {
    const url = buildCallbackRedirectUrl("https://my.stll.app", {
      status: "error",
      reason: "expired-state",
    });

    expect(url).toBe(
      "https://my.stll.app/mcp/oauth-callback?status=error&reason=expired-state",
    );
  });

  test("percent-encodes slugs that contain whitespace", () => {
    const url = buildCallbackRedirectUrl("https://example.test/", {
      status: "connected",
      slug: "with space",
    });

    expect(url).toBe(
      "https://example.test/mcp/oauth-callback?status=connected&slug=with+space",
    );
  });
});

type CallbackCtx = Parameters<typeof mcpOAuthCallback.handler>[0];

const STATE_TTL_MS = 10 * 60 * 1000;
const orgA = toSafeId<"organization">("org_a");
const orgB = toSafeId<"organization">("org_b");
const userA = toSafeId<"user">("user_a");
const userB = toSafeId<"user">("user_b");

const stateRow = (overrides: Record<string, unknown> = {}) => ({
  organizationId: orgA,
  userId: userA,
  createdAt: new Date(),
  connectorId: toSafeId<"mcpConnector">("conn_1"),
  authorizationServerUrl: "https://as.example.com",
  codeVerifier: "verifier",
  redirectUri: "https://api.example.com/cb",
  resourceUrl: "https://rs.example.com",
  connector: {
    id: toSafeId<"mcpConnector">("conn_1"),
    slug: "acme",
    url: "https://rs.example.com",
    oauthIssuer: "https://as.example.com",
  },
  ...overrides,
});

// safeDb returns the crafted state row on the first call and counts every
// call, so we can assert no token exchange / connection insert ran after a
// rejected binding.
const callbackContext = (
  row: Record<string, unknown>,
  counter: {
    calls: number;
    review?: {
      status: "needs_reapproval" | "approved";
      approvedIssuer: string | null;
      approvedEndpointOrigins?: readonly string[];
    };
  },
): CallbackCtx =>
  asTestRaw<CallbackCtx>({
    query: { code: "auth-code", state: "state-token" },
    safeDb: asTestRaw<CallbackCtx["safeDb"]>(
      async (operation: (tx: unknown) => unknown) => {
        counter.calls += 1;
        return Result.ok(
          await operation({
            query: {
              mcpOAuthState: { findFirst: async () => row },
              mcpConnectorAuthorizationReviews: {
                findFirst: async () => counter.review,
              },
              mcpOAuthClients: { findFirst: async () => undefined },
            },
            insert: () => ({
              values: () => ({ onConflictDoUpdate: async () => {} }),
            }),
          }),
        );
      },
    ),
    scopedDb: asTestRaw<CallbackCtx["scopedDb"]>(async () => undefined),
    session: { activeOrganizationId: orgA },
    user: { id: userA },
    memberRole: sessionMemberRole("owner"),
    recordAuditEvent: async () => {},
  });

const reasonOf = (result: unknown): string | null => {
  if (!(result instanceof Response)) {
    throw new Error(`expected a 302 Response, got ${JSON.stringify(result)}`);
  }
  expect(result.status).toBe(302);
  const location = result.headers.get("Location");
  expect(location).not.toBeNull();
  return new URL(location ?? "").searchParams.get("reason");
};

describe("mcpOAuthCallback identity binding", () => {
  test("preserves current organization approval when a pending connection is outdated", async () => {
    const issuer = "https://as.example.net";
    const counter = {
      calls: 0,
      review: {
        status: "approved",
        approvedIssuer: issuer,
        approvedEndpointOrigins: [],
      } as const,
    };
    const callback = createMcpOAuthCallbackHandler(async () =>
      Result.ok({
        protectedResource: {
          resource: "https://rs.example.com",
          authorization_servers: [issuer],
        },
        authorizationServer: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
        },
      }),
    );
    expect(
      reasonOf(await callback.handler(callbackContext(stateRow(), counter))),
    ).toBe("invalid-secret");
    expect(counter.calls).toBe(2);
  });

  test("continues only with the resource recorded for the pending connection", async () => {
    const counter = { calls: 0 };
    const callback = createMcpOAuthCallbackHandler(async () =>
      Result.ok({
        protectedResource: {
          resource: "https://rs.example.com/",
          authorization_servers: ["https://as.example.com"],
        },
        authorizationServer: {
          issuer: "https://as.example.com",
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
        },
      }),
    );
    const result = await callback.handler(callbackContext(stateRow(), counter));
    expect(reasonOf(result)).toBe("invalid-secret");
    expect(counter.calls).toBe(2);
  });

  test("uses organization endpoint approval for the pending connection", async () => {
    for (const confirmed of [false, true]) {
      const counter = {
        calls: 0,
        review: {
          status: "approved",
          approvedIssuer: "https://as.example.net",
          approvedEndpointOrigins: confirmed
            ? ["https://tokens.example.org"]
            : [],
        } as const,
      };
      const callback = createMcpOAuthCallbackHandler(async () =>
        Result.ok({
          protectedResource: {
            resource: "https://rs.example.com",
            authorization_servers: ["https://as.example.net"],
          },
          authorizationServer: {
            issuer: "https://as.example.net",
            authorization_endpoint: "https://as.example.net/authorize",
            token_endpoint: "https://tokens.example.org/token",
          },
        }),
      );
      const result = await callback.handler(
        callbackContext(
          stateRow({ authorizationServerUrl: "https://as.example.net" }),
          counter,
        ),
      );
      expect(reasonOf(result)).toBe(
        confirmed ? "missing-client" : "invalid-secret",
      );
      expect(counter.calls).toBe(3);
    }
  });

  test("requires organization approval before continuing a pending connection", async () => {
    for (const resourceUrl of [
      "https://rs.example.com/other",
      "https://rs.example.com",
    ]) {
      const counter = {
        calls: 0,
        review: {
          status: "needs_reapproval",
          approvedIssuer: "https://as.example.com",
        } as const,
      };
      const result = await mcpOAuthCallback.handler(
        callbackContext(stateRow({ resourceUrl }), counter),
      );
      expect(reasonOf(result)).toBe("approval-required");
      expect(counter.calls).toBe(2);
    }
  });

  test("records a review for a connector without an approved issuer", async () => {
    const counter = { calls: 0 };
    let discovered = 0;
    const callback = createMcpOAuthCallbackHandler(async () => {
      discovered += 1;
      return Result.ok({
        protectedResource: {
          resource: "https://rs.example.com",
          authorization_servers: ["https://as.example.com"],
        },
        authorizationServer: {
          issuer: "https://as.example.com",
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
        },
      });
    });
    const result = await callback.handler(
      callbackContext(
        stateRow({
          connector: {
            id: toSafeId<"mcpConnector">("conn_1"),
            slug: "acme",
            url: "https://rs.example.com",
            oauthIssuer: null,
            oauthConfirmedEndpointOrigins: null,
          },
        }),
        counter,
      ),
    );
    expect(reasonOf(result)).toBe("approval-required");
    expect(discovered).toBe(1);
    expect(counter.calls).toBe(3);
  });

  test("uses the connector resource configured for the pending connection", async () => {
    const counter = { calls: 0 };
    const result = await mcpOAuthCallback.handler(
      callbackContext(
        stateRow({ resourceUrl: "https://rs.example.com/other" }),
        counter,
      ),
    );
    expect(reasonOf(result)).toBe("invalid-secret");
    expect(counter.calls).toBe(3);
  });

  test("rejects a state row belonging to another organization", async () => {
    const counter = { calls: 0 };
    const result = await mcpOAuthCallback.handler(
      callbackContext(stateRow({ organizationId: orgB }), counter),
    );

    expect(reasonOf(result)).toBe("user-mismatch");
    // Only the state lookup ran: no token exchange or connection insert.
    expect(counter.calls).toBe(1);
  });

  test("rejects a state row belonging to another user", async () => {
    const counter = { calls: 0 };
    const result = await mcpOAuthCallback.handler(
      callbackContext(stateRow({ userId: userB }), counter),
    );

    expect(reasonOf(result)).toBe("user-mismatch");
    expect(counter.calls).toBe(1);
  });

  test("rejects an expired state row and persists nothing", async () => {
    const counter = { calls: 0 };
    const result = await mcpOAuthCallback.handler(
      callbackContext(
        stateRow({ createdAt: new Date(Date.now() - STATE_TTL_MS - 1000) }),
        counter,
      ),
    );

    expect(reasonOf(result)).toBe("expired-state");
    expect(counter.calls).toBe(1);
  });

  test("missing code or state short-circuits before any DB call", async () => {
    const counter = { calls: 0 };
    const ctx = callbackContext(stateRow(), counter);
    const result = await mcpOAuthCallback.handler(
      asTestRaw<CallbackCtx>({
        ...ctx,
        query: { code: undefined, state: undefined },
      }),
    );

    expect(reasonOf(result)).toBe("missing-code");
    expect(counter.calls).toBe(0);
  });

  // A safeDb failure surfaces as Result.err, not a thrown exception. The
  // callback must still redirect (never a raw JSON error body) so the popup
  // can close itself instead of showing an API error page.
  test("redirects instead of leaking a raw error when a DB lookup fails", async () => {
    const result = await mcpOAuthCallback.handler(
      failingLookupContext(
        new HandlerError({ status: 500, message: "db down" }),
      ),
    );

    expect(reasonOf(result)).toBe("invalid-secret");
  });
});

const scopedRequest = (): Request => {
  const request = new Request("https://api.test/mcp/oauth/callback");
  initRequestContext(request);
  return request;
};

const failingLookupContext = (
  error: unknown,
  request: Request = scopedRequest(),
): CallbackCtx =>
  asTestRaw<CallbackCtx>({
    query: { code: "auth-code", state: "state-token" },
    request,
    safeDb: asTestRaw<CallbackCtx["safeDb"]>(async () => Result.err(error)),
    scopedDb: asTestRaw<CallbackCtx["scopedDb"]>(async () => undefined),
    session: { activeOrganizationId: orgA },
    user: { id: userA },
    memberRole: sessionMemberRole("owner"),
    recordAuditEvent: async () => {},
  });

describe("mcpOAuthCallback failure reporting", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  const failureRecords = () =>
    logs.records.filter((record) => record.message === "oauth_callback.failed");

  test("reports a server-side handler error and keeps the invalid-secret redirect", async () => {
    const result = await mcpOAuthCallback.handler(
      failingLookupContext(
        new HandlerError({
          status: 500,
          message: "Stored MCP secret envelope is invalid",
        }),
      ),
    );

    expect(reasonOf(result)).toBe("invalid-secret");
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "HandlerError", operation: "mcp_oauth_callback" },
    ]);
  });

  test("does not report a client-side handler error", async () => {
    const result = await mcpOAuthCallback.handler(
      failingLookupContext(
        new HandlerError({ status: 403, message: "Not allowed" }),
      ),
    );

    expect(reasonOf(result)).toBe("invalid-secret");
    expect(analytics.exceptions()).toEqual([]);
  });

  test("logs the failure with the request id", async () => {
    const request = scopedRequest();
    await mcpOAuthCallback.handler(
      failingLookupContext(
        new HandlerError({ status: 500, message: "db down" }),
        request,
      ),
    );

    expect(failureRecords().map((record) => record.attributes)).toMatchObject([
      { "request.id": getRequestId(request), operation: "mcp_oauth_callback" },
    ]);
  });

  test("logs a transient network failure as a warning without reporting it", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const result = await mcpOAuthCallback.handler(
      failingLookupContext(
        new DatabaseError({ message: "connection reset", cause: reset }),
      ),
    );

    expect(reasonOf(result)).toBe("unexpected");
    expect(failureRecords().map((record) => record.severityText)).toEqual([
      "WARN",
    ]);
    expect(analytics.exceptions()).toEqual([]);
  });
});
