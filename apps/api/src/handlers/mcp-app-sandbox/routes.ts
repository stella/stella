import Elysia from "elysia";
import type { Context } from "elysia";

import { MCP_APP_SANDBOX_PATH } from "@stll/api-contract";

import { env } from "@/api/env";
import { frontendOrigins } from "@/api/lib/dev-origins";

const allowedHostOrigins = frontendOrigins({
  frontendUrl: env.FRONTEND_URL,
  isDev: env.isDev,
}).map((origin) => new URL(origin).origin);

const allowedHostOriginsJson = JSON.stringify(allowedHostOrigins);
const frameAncestors = allowedHostOrigins.join(" ");

export const MCP_APP_SANDBOX_DOCUMENT = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP App sandbox</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
      body { display: flex; }
      iframe { flex: 1; width: 100%; height: 100%; border: 0; background: transparent; }
    </style>
  </head>
  <body>
    <script>
      const allowedHostOrigins = ${allowedHostOriginsJson};
      if (window.self === window.top) throw new Error("Sandbox must be framed");
      if (!document.referrer) throw new Error("Sandbox requires a referrer");
      const expectedHostOrigin = new URL(document.referrer).origin;
      if (!allowedHostOrigins.includes(expectedHostOrigin)) {
        throw new Error("Sandbox host is not allowed");
      }
      if (window.location.origin === expectedHostOrigin) {
        throw new Error("Sandbox and host must use different origins");
      }

      const inner = document.createElement("iframe");
      inner.setAttribute("sandbox", "allow-scripts allow-forms");
      document.body.appendChild(inner);

      const resourceReady = "ui/notifications/sandbox-resource-ready";
      const proxyReady = "ui/notifications/sandbox-proxy-ready";

      window.addEventListener("message", (event) => {
        if (event.source === window.parent) {
          if (event.origin !== expectedHostOrigin) return;
          if (event.data?.method === resourceReady) {
            const html = event.data.params?.html;
            if (typeof html === "string") inner.srcdoc = html;
            return;
          }
          inner.contentWindow?.postMessage(event.data, "*");
          return;
        }
        if (event.source === inner.contentWindow) {
          window.parent.postMessage(event.data, expectedHostOrigin);
        }
      });

      window.parent.postMessage({
        jsonrpc: "2.0",
        method: proxyReady,
        params: {}
      }, expectedHostOrigin);
    </script>
  </body>
</html>`;

const SANDBOX_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  `frame-ancestors ${frameAncestors}`,
].join("; ");

const clearInheritedFrameDenial = (set: Context["set"]): void => {
  // The API defaults every response to DENY / frame-ancestors 'none'. This
  // route replaces that policy with the exact frontend allowlist below.
  delete set.headers["X-Frame-Options"];
  delete set.headers["Content-Security-Policy"];
};

export const mcpAppSandboxRoute = new Elysia().get(
  MCP_APP_SANDBOX_PATH,
  ({ set }) => {
    clearInheritedFrameDenial(set);
    return new Response(MCP_APP_SANDBOX_DOCUMENT, {
      headers: {
        "Cache-Control": "public, max-age=86400",
        "Content-Security-Policy": SANDBOX_CONTENT_SECURITY_POLICY,
        "Content-Type": "text/html; charset=utf-8",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
);
