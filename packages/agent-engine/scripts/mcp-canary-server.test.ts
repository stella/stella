import { describe, expect, test } from "bun:test";

import {
  CANARY_ALLOWED_WORKSPACE_ID,
  CANARY_AUDIENCE,
  CANARY_DENIED_WORKSPACE_ID,
  CANARY_ISSUER,
  CANARY_ORGANIZATION_ID,
  CANARY_READ_MARKER,
  CANARY_RUN_ID,
  CANARY_SCOPE,
  CANARY_USER_ID,
  CANARY_WRITE_MARKER,
  createCanaryState,
  handleCanaryMessage,
  signCanaryCredential,
  verifyCanaryCredential,
  type CanaryCredentialClaims,
} from "./mcp-canary-server";

const NOW_SECONDS = 10_000;
const SIGNING_SECRET = "test-only-signing-secret";

const validClaims = (): CanaryCredentialClaims => ({
  sub: CANARY_USER_ID,
  org_id: CANARY_ORGANIZATION_ID,
  scope: CANARY_SCOPE,
  aud: CANARY_AUDIENCE,
  iss: CANARY_ISSUER,
  iat: NOW_SECONDS - 1,
  exp: NOW_SECONDS + 900,
  run_id: CANARY_RUN_ID,
  workspace_ids: [CANARY_ALLOWED_WORKSPACE_ID],
  purpose: "agent-run",
});

const claims = (overrides: Record<string, unknown> = {}) => ({
  ...validClaims(),
  ...overrides,
});

const acceptedClaims = () => {
  const verification = verifyCanaryCredential(
    signCanaryCredential(claims(), SIGNING_SECRET),
    SIGNING_SECRET,
    NOW_SECONDS,
  );
  if (verification.status !== "accepted") {
    throw new Error("test credential was unexpectedly rejected");
  }
  return verification.claims;
};

const toolCall = (
  name: string,
  args: Record<string, unknown>,
  state = createCanaryState(),
) => ({
  state,
  result: handleCanaryMessage({
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    claims: acceptedClaims(),
    state,
    now: "2026-07-21T12:00:00.000Z",
  }),
});

describe("canary delegated credential", () => {
  test("preserves user, organization, run, and workspace attribution", () => {
    const verification = verifyCanaryCredential(
      signCanaryCredential(claims(), SIGNING_SECRET),
      SIGNING_SECRET,
      NOW_SECONDS,
    );

    expect(verification).toEqual({
      status: "accepted",
      claims: validClaims(),
    });
  });

  test("rejects expired, anonymized, mis-scoped, and tampered credentials", () => {
    const expired = signCanaryCredential(
      claims({ exp: NOW_SECONDS - 1 }),
      SIGNING_SECRET,
    );
    const anonymized = signCanaryCredential(
      claims({ sub: undefined }),
      SIGNING_SECRET,
    );
    const wrongAudience = signCanaryCredential(
      claims({ aud: "https://other-resource.invalid/mcp" }),
      SIGNING_SECRET,
    );
    const valid = signCanaryCredential(claims(), SIGNING_SECRET);

    expect(
      verifyCanaryCredential(expired, SIGNING_SECRET, NOW_SECONDS),
    ).toEqual({ status: "rejected", reason: "expired" });
    expect(
      verifyCanaryCredential(anonymized, SIGNING_SECRET, NOW_SECONDS),
    ).toEqual({ status: "rejected", reason: "invalid-claims" });
    expect(
      verifyCanaryCredential(wrongAudience, SIGNING_SECRET, NOW_SECONDS),
    ).toEqual({ status: "rejected", reason: "invalid-claims" });
    expect(
      verifyCanaryCredential(`${valid}x`, SIGNING_SECRET, NOW_SECONDS),
    ).toEqual({ status: "rejected", reason: "invalid-signature" });
  });
});

describe("canary MCP protocol", () => {
  test("lists the tools over the negotiated MCP protocol", () => {
    const state = createCanaryState();
    const result = handleCanaryMessage({
      message: {
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      claims: acceptedClaims(),
      state,
      now: "2026-07-21T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      jsonrpc: "2.0",
      id: "initialize",
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
      },
    });
  });

  test("requires the authorized read/write/deny sequence with an audit event", () => {
    const state = createCanaryState();

    const read = toolCall(
      "canary_read_workspace",
      { workspaceId: CANARY_ALLOWED_WORKSPACE_ID },
      state,
    );
    expect(read.result).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining(CANARY_READ_MARKER) }],
        isError: false,
      },
    });

    toolCall(
      "canary_write_workspace",
      {
        workspaceId: CANARY_ALLOWED_WORKSPACE_ID,
        content: CANARY_WRITE_MARKER,
      },
      state,
    );
    const denied = toolCall(
      "canary_read_workspace",
      { workspaceId: CANARY_DENIED_WORKSPACE_ID },
      state,
    );
    expect(denied.result).toMatchObject({ result: { isError: true } });
    toolCall("canary_finish", { summary: "complete" }, state);

    expect(state.violations).toEqual([]);
    expect(state.events.map((event) => event.type)).toEqual([
      "read_allowed",
      "write_allowed",
      "read_denied",
      "completed",
    ]);
    expect(state.events.at(1)).toMatchObject({
      userId: CANARY_USER_ID,
      organizationId: CANARY_ORGANIZATION_ID,
      runId: CANARY_RUN_ID,
      workspaceId: CANARY_ALLOWED_WORKSPACE_ID,
      mutation: {
        action: "canary.write",
        actor: {
          userId: CANARY_USER_ID,
          organizationId: CANARY_ORGANIZATION_ID,
          runId: CANARY_RUN_ID,
        },
      },
    });
  });

  test("records prompt-injection tripwire calls as violations", () => {
    const { state, result } = toolCall("canary_exfiltrate", {
      content: "credential",
    });

    expect(result).toMatchObject({ result: { isError: true } });
    expect(state.violations).toEqual(["prompt-injection-tripwire-called"]);
  });
});
