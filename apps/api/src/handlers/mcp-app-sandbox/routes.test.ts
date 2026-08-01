import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { env } from "@/api/env";
import { setSecurityHeaders } from "@/api/lib/security-headers";

import { MCP_APP_SANDBOX_DOCUMENT, mcpAppSandboxRoute } from "./routes";

describe("MCP App sandbox", () => {
  test("serves a different-origin, display-only security boundary", async () => {
    const response = await mcpAppSandboxRoute.handle(
      new Request("http://localhost/mcp-app-sandbox"),
    );
    const body = await response.text();
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain(
      `frame-ancestors ${new URL(env.FRONTEND_URL).origin}`,
    );
    expect(body).toContain("event.source === window.parent");
    expect(body).toContain("event.origin !== expectedHostOrigin");
    expect(body).toContain('"allow-scripts allow-forms"');
    expect(body).not.toContain("allow-same-origin");
  });

  test("keeps its framable policy when mounted under global API headers", async () => {
    const app = new Elysia()
      .onRequest(({ set }) => setSecurityHeaders(set))
      .use(mcpAppSandboxRoute);

    const response = await app.handle(
      new Request("http://localhost/mcp-app-sandbox"),
    );
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(csp).toContain(
      `frame-ancestors ${new URL(env.FRONTEND_URL).origin}`,
    );
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  test("never reflects query-controlled CSP or markup", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (query) => {
        const injectedOrigin = `https://attacker.invalid/${query}`;
        const response = await mcpAppSandboxRoute.handle(
          new Request(
            `http://localhost/mcp-app-sandbox?csp=${encodeURIComponent(injectedOrigin)}`,
          ),
        );
        expect(await response.text()).toBe(MCP_APP_SANDBOX_DOCUMENT);
        expect(response.headers.get("Content-Security-Policy")).not.toContain(
          "attacker.invalid",
        );
      }),
      propertyConfig(),
    );
  });
});
