import {
  MCP_APP_FRAME_TITLE_HASH_PARAM,
  MCP_APP_FRAME_TITLE_MAX_CHARS,
  MCP_APP_SANDBOX_PATH,
} from "@stll/api-contract";
import { MCP_APP_SANDBOX_CONTENT_DIRECTIVES } from "@stll/api-contract/mcp-app-sandbox-policy";

import { env } from "@/api/env";
import { routes } from "@/api/http/route";
import { frontendOrigins } from "@/api/lib/dev-origins";
import { defineEndpoint } from "@/api/lib/endpoints";
import { EMBEDDABLE_FRAME_HEADERS } from "@/api/lib/security-headers";
import { runtimeMode } from "@/api/runtime-mode";

const allowedHostOrigins = frontendOrigins({
  frontendUrl: env.FRONTEND_URL,
  runtimeMode: runtimeMode(),
}).map((origin) => new URL(origin).origin);

const allowedHostOriginsJson = JSON.stringify(allowedHostOrigins);
const frameAncestors = allowedHostOrigins.join(" ");
const frameTitleHashParamJson = JSON.stringify(MCP_APP_FRAME_TITLE_HASH_PARAM);

export const MCP_APP_SANDBOX_DOCUMENT = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP App</title>
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
      const referrerOrigin = document.referrer
        ? new URL(document.referrer).origin
        : null;
      if (referrerOrigin && !allowedHostOrigins.includes(referrerOrigin)) {
        throw new Error("Sandbox host is not allowed");
      }
      if (referrerOrigin && window.location.origin === referrerOrigin) {
        throw new Error("Sandbox and host must use different origins");
      }
      let expectedHostOrigin = referrerOrigin;

      const inner = document.createElement("iframe");
      const requestedFrameTitle = new URLSearchParams(
        window.location.hash.slice(1)
      ).get(${frameTitleHashParamJson});
      const normalizedFrameTitle = requestedFrameTitle?.trim();
      const frameTitle = normalizedFrameTitle &&
        normalizedFrameTitle.length <= ${MCP_APP_FRAME_TITLE_MAX_CHARS}
        ? normalizedFrameTitle
        : "MCP App";
      inner.setAttribute("title", frameTitle);
      inner.setAttribute("sandbox", "allow-scripts allow-forms");
      document.body.appendChild(inner);

      const resourceReady = "ui/notifications/sandbox-resource-ready";
      const proxyReady = "ui/notifications/sandbox-proxy-ready";

      window.addEventListener("message", (event) => {
        if (event.source === window.parent) {
          if (!allowedHostOrigins.includes(event.origin)) return;
          if (window.location.origin === event.origin) return;
          if (expectedHostOrigin && event.origin !== expectedHostOrigin) return;
          expectedHostOrigin ??= event.origin;
          if (event.data?.method === resourceReady) {
            const html = event.data.params?.html;
            if (typeof html === "string") inner.srcdoc = html;
            return;
          }
          inner.contentWindow?.postMessage(event.data, "*");
          return;
        }
        if (event.source === inner.contentWindow) {
          if (expectedHostOrigin) {
            window.parent.postMessage(event.data, expectedHostOrigin);
          }
        }
      });

      const readyMessage = {
        jsonrpc: "2.0",
        method: proxyReady,
        params: {}
      };
      for (const hostOrigin of allowedHostOrigins) {
        if (window.location.origin !== hostOrigin &&
            (!expectedHostOrigin || hostOrigin === expectedHostOrigin)) {
          window.parent.postMessage(readyMessage, hostOrigin);
        }
      }
    </script>
  </body>
</html>`;

const SANDBOX_CONTENT_SECURITY_POLICY = [
  ...MCP_APP_SANDBOX_CONTENT_DIRECTIVES,
  `frame-ancestors ${frameAncestors}`,
].join("; ");

/**
 * The sandbox document, framed by the web app only. Its own policy names the
 * exact frontend `frame-ancestors`, which replaces the API's frame denial.
 */
const mcpAppSandboxDocument = defineEndpoint.public(
  {},
  () =>
    new Response(MCP_APP_SANDBOX_DOCUMENT, {
      headers: {
        ...EMBEDDABLE_FRAME_HEADERS,
        "Content-Security-Policy": SANDBOX_CONTENT_SECURITY_POLICY,
        "Content-Type": "text/html; charset=utf-8",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    }),
);

export const mcpAppSandboxRoute = routes({
  [MCP_APP_SANDBOX_PATH]: { GET: mcpAppSandboxDocument },
});
