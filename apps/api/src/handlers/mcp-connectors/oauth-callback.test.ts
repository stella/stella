import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import mcpOAuthCallback, {
  buildCallbackRedirectUrl,
} from "@/api/handlers/mcp-connectors/oauth-callback";
import { toSafeId } from "@/api/lib/branded-types";
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
  connector: { id: toSafeId<"mcpConnector">("conn_1"), slug: "acme" },
  ...overrides,
});

// safeDb returns the crafted state row on the first call and counts every
// call, so we can assert no token exchange / connection insert ran after a
// rejected binding.
const callbackContext = (
  row: Record<string, unknown>,
  counter: { calls: number },
): CallbackCtx =>
  asTestRaw<CallbackCtx>({
    query: { code: "auth-code", state: "state-token" },
    safeDb: asTestRaw<CallbackCtx["safeDb"]>(async () => {
      counter.calls += 1;
      return Result.ok(row);
    }),
    scopedDb: asTestRaw<CallbackCtx["scopedDb"]>(async () => undefined),
    session: { activeOrganizationId: orgA },
    user: { id: userA },
    memberRole: { role: "owner" },
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
});
