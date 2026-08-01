import { describe, expect, mock, test } from "bun:test";
import fc from "fast-check";
import { runInNewContext } from "node:vm";

import { propertyConfig } from "@stll/property-testing";

import { env } from "@/api/env";
import api from "@/api/server";

import { MCP_APP_SANDBOX_DOCUMENT } from "./routes";

type SandboxMessageEvent = {
  data: unknown;
  origin: string;
  source: unknown;
};

const sandboxScript = () => {
  const openingTag = "<script>";
  const closingTag = "</script>";
  const start = MCP_APP_SANDBOX_DOCUMENT.indexOf(openingTag);
  const end = MCP_APP_SANDBOX_DOCUMENT.indexOf(closingTag, start);
  if (start === -1 || end === -1) {
    throw new Error("Expected the sandbox document to contain a script");
  }
  return MCP_APP_SANDBOX_DOCUMENT.slice(start + openingTag.length, end);
};

describe("MCP App sandbox", () => {
  test("serves a different-origin, display-only security boundary", async () => {
    const response = await api.handle(
      new Request("http://localhost/mcp-app-sandbox"),
    );
    const body = await response.text();
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain(
      `frame-ancestors ${new URL(env.FRONTEND_URL).origin}`,
    );
    expect(body).toContain("event.source === window.parent");
    expect(body).toContain("allowedHostOrigins.includes(event.origin)");
    expect(body).toContain("event.origin !== expectedHostOrigin");
    expect(body).toContain("expectedHostOrigin ??= event.origin");
    expect(body).not.toContain("Sandbox requires a referrer");
    expect(body).toContain('"allow-scripts allow-forms"');
    expect(body).not.toContain("allow-same-origin");
  });

  test("pins an allowlisted parent origin when no referrer is available", () => {
    const hostOrigin = new URL(env.FRONTEND_URL).origin;
    const parentPostMessage = mock(() => undefined);
    const parentWindow = { postMessage: parentPostMessage };
    const innerPostMessage = mock(() => undefined);
    const innerWindow = { postMessage: innerPostMessage };
    const innerFrame = {
      contentWindow: innerWindow,
      setAttribute: mock(() => undefined),
      srcdoc: "",
    };
    let messageHandler: ((event: SandboxMessageEvent) => void) | undefined;

    runInNewContext(sandboxScript(), {
      URL,
      document: {
        body: { appendChild: mock(() => undefined) },
        createElement: () => innerFrame,
        referrer: "",
      },
      window: {
        addEventListener: (
          _type: string,
          handler: (event: SandboxMessageEvent) => void,
        ) => {
          messageHandler = handler;
        },
        location: { origin: "https://api.example.test" },
        parent: parentWindow,
        self: {},
        top: {},
      },
    });

    expect(parentPostMessage).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-proxy-ready",
        params: {},
      },
      hostOrigin,
    );
    if (!messageHandler) {
      throw new Error("Expected the sandbox to install a message handler");
    }

    messageHandler({
      data: {
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "<p>Attacker</p>" },
      },
      origin: "https://attacker.invalid",
      source: parentWindow,
    });
    expect(innerFrame.srcdoc).toBe("");

    messageHandler({
      data: {
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "<p>Widget</p>" },
      },
      origin: hostOrigin,
      source: parentWindow,
    });
    expect(innerFrame.srcdoc).toBe("<p>Widget</p>");

    parentPostMessage.mockClear();
    const guestMessage = { jsonrpc: "2.0", method: "ui/initialize" };
    messageHandler({ data: guestMessage, origin: "null", source: innerWindow });
    expect(parentPostMessage).toHaveBeenCalledWith(guestMessage, hostOrigin);
  });

  test("keeps its framable policy when mounted under global API headers", async () => {
    const response = await api.handle(
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
        const response = await api.handle(
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
