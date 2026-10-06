import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { describe, expect, test } from "bun:test";

import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";

import {
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
