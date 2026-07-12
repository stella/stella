import { describe, expect, test } from "bun:test";

import {
  AGENT_RUN_DEFAULT_SCOPES,
  buildAgentRunTokenClaims,
} from "@/api/mcp/agent-run-token";

const claims = (
  overrides: Partial<Parameters<typeof buildAgentRunTokenClaims>[0]> = {},
) =>
  buildAgentRunTokenClaims({
    userId: "user_1",
    organizationId: "org_1",
    runId: "run_1",
    scopes: AGENT_RUN_DEFAULT_SCOPES,
    audience: "https://mcp.example.test/mcp",
    issuer: "https://auth.example.test",
    nowSeconds: 1_000,
    ttlSeconds: 900,
    ...overrides,
  });

describe("buildAgentRunTokenClaims", () => {
  test("attributes the token to the user for auditability", () => {
    expect(claims().sub).toBe("user_1");
    expect(claims().org_id).toBe("org_1");
    expect(claims().run_id).toBe("run_1");
    expect(claims().purpose).toBe("agent-run");
  });

  test("targets the MCP resource and issuer so the existing verifier accepts it", () => {
    expect(claims().aud).toBe("https://mcp.example.test/mcp");
    expect(claims().iss).toBe("https://auth.example.test");
  });

  test("expires after exactly the TTL from issuance", () => {
    expect(claims().iat).toBe(1_000);
    expect(claims().exp).toBe(1_900);
  });

  test("default scope is least-privilege: no admin or billing", () => {
    const scopeSet = new Set(claims().scope.split(" "));
    expect(scopeSet.has("stella:read")).toBe(true);
    expect(scopeSet.has("stella:chat")).toBe(true);
    expect(scopeSet.has("stella:admin_write")).toBe(false);
    expect(scopeSet.has("stella:billing_write")).toBe(false);
    expect(scopeSet.has("stella:onboarding")).toBe(false);
  });

  test("a narrower scope list attenuates further", () => {
    expect(claims({ scopes: ["stella:read"] }).scope).toBe("stella:read");
  });
});
