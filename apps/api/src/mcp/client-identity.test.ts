import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { afterEach, describe, expect, test } from "bun:test";

import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";

import {
  resetAnalyticsForTesting,
  setAnalyticsForTesting,
} from "@/api/lib/analytics/client";
import type { ServerAnalyticsCaptureParams } from "@/api/lib/analytics/server-analytics";
import { SYNTHETIC_PRINCIPAL } from "@/api/lib/synthetic-principal/constants";
import type { McpSession } from "@/api/mcp/auth";
import {
  createRecordMcpSessionInitialized,
  sanitizeMcpClientIdentity,
  sanitizeMcpUiCapabilities,
} from "@/api/mcp/client-identity";

describe("sanitizeMcpClientIdentity", () => {
  test("keeps a well-formed identity", () => {
    expect(
      sanitizeMcpClientIdentity({ name: "claude-ai", version: "1.4.2" }),
    ).toEqual({ clientName: "claude-ai", clientVersion: "1.4.2" });
  });

  test("caps each reported field at 128 characters", () => {
    const identity = sanitizeMcpClientIdentity({
      name: "n".repeat(400),
      version: "1.".repeat(400),
    });

    expect(identity.clientName).toHaveLength(128);
    expect(identity.clientVersion).toHaveLength(128);
  });

  test("drops non-string fields instead of reporting them", () => {
    expect(
      sanitizeMcpClientIdentity({
        name: { toString: () => "injected" },
        version: 42,
      }),
    ).toEqual({ clientName: "unspecified" });
    expect(sanitizeMcpClientIdentity("claude-ai")).toEqual({
      clientName: "unspecified",
    });
    expect(sanitizeMcpClientIdentity(undefined)).toEqual({
      clientName: "unspecified",
    });
  });

  test("leaves an unreported version out rather than inventing one", () => {
    expect(sanitizeMcpClientIdentity({ name: "claude-ai" })).toEqual({
      clientName: "claude-ai",
    });
  });

  test("treats a blank name as unreported", () => {
    expect(sanitizeMcpClientIdentity({ name: "   ", version: "  " })).toEqual({
      clientName: "unspecified",
    });
  });
});

describe("MCP App capability telemetry", () => {
  test("pins negotiation constants to the specification SDK", () => {
    expect(MCP_APP_EXTENSION_ID).toBe(EXTENSION_ID);
    expect(MCP_APP_RESOURCE_MIME_TYPE).toBe(RESOURCE_MIME_TYPE);
  });

  test("reports supported apps and only allowlisted MIME types once", () => {
    expect(
      sanitizeMcpUiCapabilities({
        extensions: {
          [MCP_APP_EXTENSION_ID]: {
            mimeTypes: [
              MCP_APP_RESOURCE_MIME_TYPE,
              "application/private",
              MCP_APP_RESOURCE_MIME_TYPE,
            ],
          },
        },
      }),
    ).toEqual({
      uiAppsSupported: true,
      uiAppsMimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
    });
  });

  test("reports unsupported clients without copying their capabilities", () => {
    for (const capabilities of [
      undefined,
      {},
      { extensions: {} },
      {
        extensions: {
          [MCP_APP_EXTENSION_ID]: { mimeTypes: ["application/private"] },
        },
      },
      { extensions: { [MCP_APP_EXTENSION_ID]: {} } },
    ]) {
      expect(sanitizeMcpUiCapabilities(capabilities)).toEqual({
        uiAppsSupported: false,
        uiAppsMimeTypes: [],
      });
    }
  });

  test("rejects malformed capability objects and MIME lists", () => {
    for (const capabilities of [
      null,
      "ui",
      [],
      { extensions: null },
      {
        extensions: {
          [MCP_APP_EXTENSION_ID]: true,
        },
      },
      {
        extensions: {
          [MCP_APP_EXTENSION_ID]: { mimeTypes: MCP_APP_RESOURCE_MIME_TYPE },
        },
      },
      {
        extensions: {
          [MCP_APP_EXTENSION_ID]: {
            mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE, 42],
          },
        },
      },
    ]) {
      expect(sanitizeMcpUiCapabilities(capabilities)).toEqual({
        uiAppsSupported: false,
        uiAppsMimeTypes: [],
      });
    }
  });
});

describe("MCP session telemetry audience", () => {
  const reviewAccount = {
    email: "restricted@example.test",
    organizationId: "org_review",
  };
  const record = createRecordMcpSessionInitialized(() => reviewAccount);
  const recording = () => {
    const captured: ServerAnalyticsCaptureParams[] = [];
    setAnalyticsForTesting({
      capture: (params) => {
        captured.push(params);
      },
      identifyOrganizationGroup: () => undefined,
      flush: async () => await Promise.resolve(),
    });
    return captured;
  };
  const handshake = (session: McpSession) => {
    record({
      capabilities: {},
      clientInfo: { name: "claude-ai", version: "1.0.0" },
      mode: "default",
      session,
    });
  };

  afterEach(() => {
    resetAnalyticsForTesting();
  });

  test("counts a customer's handshake", () => {
    const captured = recording();

    handshake({
      credential: { clientId: "client_1", type: "oauth_client" },
      organizationId: "org_1",
      scopes: ["stella:read"],
      userId: "user_1",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      distinctId: "user_1",
      event: "mcp_session_initialized",
      groups: { organization: "org_1" },
    });
  });

  test("leaves out the review account's handshakes under every credential", () => {
    const captured = recording();

    for (const credential of [
      {
        id: "key_1",
        name: "automation",
        permissions: { workspace: ["read"] },
        type: "machine_api_key",
      },
      { clientId: "client_1", type: "oauth_client" },
    ] satisfies McpSession["credential"][]) {
      handshake({
        credential,
        organizationId: reviewAccount.organizationId,
        scopes: ["stella:read"],
        userId: "user_review",
      });
    }

    expect(captured).toEqual([]);
  });

  test("leaves out the synthetic principal", () => {
    const captured = recording();

    handshake({
      credential: { type: "delegated_user" },
      organizationId: SYNTHETIC_PRINCIPAL.org.id,
      scopes: ["stella:read"],
      userId: SYNTHETIC_PRINCIPAL.user.id,
    });

    expect(captured).toEqual([]);
  });
});
