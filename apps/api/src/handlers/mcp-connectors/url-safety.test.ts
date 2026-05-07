import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  parseSafeMcpUrl,
  validateSafeMcpFetchUrl,
} from "@/api/handlers/mcp-connectors/url-safety";

describe("MCP URL safety", () => {
  test("rejects non-HTTPS MCP URLs", () => {
    const parsed = parseSafeMcpUrl("http://example.com/mcp");

    expect(Result.isError(parsed)).toBe(true);
  });

  test("rejects credential-bearing MCP URLs", () => {
    const parsed = parseSafeMcpUrl("https://user:pass@example.com/mcp");

    expect(Result.isError(parsed)).toBe(true);
  });

  test("rejects private literal hosts before server-side fetches", async () => {
    const validated = await validateSafeMcpFetchUrl("https://127.0.0.1/mcp");

    expect(Result.isError(validated)).toBe(true);
  });
});
