import { describe, expect, test } from "bun:test";

import {
  normalizeMcpConnectorUrl,
  mcpConnectorUrlIdentity,
} from "@/api/handlers/mcp-connectors/url-normalization";

test("normalizes repeated root slashes consistently", () => {
  expect(normalizeMcpConnectorUrl("https://mcp.example.com///").unwrap()).toBe(
    "https://mcp.example.com",
  );
});

describe("mcpConnectorUrlIdentity scheme handling", () => {
  test("defaults a bare host to https", () => {
    expect(mcpConnectorUrlIdentity("mcp.example.com")).toBe(
      "https://mcp.example.com",
    );
  });

  test("preserves an explicit http scheme", () => {
    expect(mcpConnectorUrlIdentity("http://localhost:3001/mcp")).toBe(
      "http://localhost:3001/mcp",
    );
  });

  test("preserves an explicit https scheme", () => {
    expect(mcpConnectorUrlIdentity("https://mcp.example.com")).toBe(
      "https://mcp.example.com",
    );
  });

  test("does not double-prefix and normalizes scheme case", () => {
    expect(mcpConnectorUrlIdentity("HTTPS://mcp.example.com")).toBe(
      "https://mcp.example.com",
    );
  });

  test("trims and strips a trailing slash on a bare host with path", () => {
    expect(mcpConnectorUrlIdentity("  mcp.example.com/api/  ")).toBe(
      "https://mcp.example.com/api",
    );
  });
});
