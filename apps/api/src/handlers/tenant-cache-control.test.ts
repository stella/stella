import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { getPublicHandlerCachePolicy } from "@/api/lib/api-handlers";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import {
  MCP_MODES,
  MCP_RESOURCE_MODE_CONFIG,
} from "@/api/mcp/resource-policy-contract";
import api from "@/api/server";

// TTL changes and new shared-cache routes require an explicit review decision.
const DISCOVERY_CACHE_HEADER =
  "public, max-age=300, stale-while-revalidate=3600";
const PUBLIC_CACHE_HEADERS = {
  "GET /.well-known/oauth-authorization-server": DISCOVERY_CACHE_HEADER,
  "GET /.well-known/oauth-authorization-server/api/auth":
    DISCOVERY_CACHE_HEADER,
  "GET /.well-known/openid-configuration": DISCOVERY_CACHE_HEADER,
  "GET /.well-known/oauth-protected-resource": DISCOVERY_CACHE_HEADER,
  ...Object.fromEntries(
    MCP_MODES.map((mode) => [
      `GET ${MCP_RESOURCE_MODE_CONFIG[mode].discoveryPath}`,
      DISCOVERY_CACHE_HEADER,
    ]),
  ),
  "GET /auth.md": "public, max-age=300",
  "GET /v1/mcp/oauth/client-metadata.json": "public, max-age=3600",
  "GET /v1/mcp/oauth/cli-client-metadata.json": "public, max-age=3600",
  "GET /v1/mcp/oauth/mobile-client-metadata.json": "public, max-age=3600",
  "GET /v1/case/coverage": "public, max-age=900, stale-while-revalidate=3600",
  "GET /v1/case/judges/:judgeId/portrait": "public, max-age=86400",
  "GET /v1/law/statutes/:documentId/provisions/:anchor/preview":
    "public, max-age=3600, stale-while-revalidate=86400",
  "GET /v1/public/knowledge/template-packs": "public, max-age=300",
  "GET /v1/public/knowledge/template-packs/:packId": "public, max-age=300",
  "GET /v1/public/knowledge/template-packs/:packId/templates/:templateId":
    "public, max-age=300",
  "GET /v1/public/knowledge/template-packs/:packId/templates/:templateId/preview":
    "public, max-age=300",
  "GET /v1/public/knowledge/playbook-starters": "public, max-age=300",
  "GET /v1/public/knowledge/playbook-starters/:id": "public, max-age=300",
} as const satisfies Record<string, string>;

// Elysia stores lifecycle hook containers outside LocalHook's declared type.
const firstRouteHook = (hooks: unknown, name: string) => {
  if (!isRecord(hooks)) {
    return panic(`Missing route ${name} hooks`);
  }
  const entries = hooks[name];
  if (!isUnknownArray(entries)) {
    return panic(`Missing route ${name} hooks`);
  }
  const hook = entries.at(0);
  if (!isRecord(hook) || typeof hook["fn"] !== "function") {
    return panic(`Missing first route ${name} hook`);
  }
  return hook["fn"];
};

describe("composed API cache policy", () => {
  test("every mounted route declares its response cache policy", async () => {
    expect(api.routes.length).toBeGreaterThan(100);
    const observedPublicHeaders: Record<string, string> = {};
    // onRequest executes from the app's global event list before route lookup.
    const firstRequestHook = firstRouteHook(api.event, "request");

    for (const route of api.routes) {
      const routeName = `${route.method} ${route.path}`;
      const set = { headers: {} };
      await firstRequestHook({ set });
      expect(new Headers(set.headers).get("Cache-Control"), routeName).toBe(
        "private, no-store",
      );

      const mapResponse = firstRouteHook(route.hooks, "mapResponse");
      const response = await mapResponse({
        set,
        responseValue: new Response("example"),
      });
      expect(response, routeName).toBeInstanceOf(Response);
      if (!(response instanceof Response)) {
        panic(`Missing finalized response for ${routeName}`);
      }
      expect(response.headers.get("Cache-Control"), routeName).toBe(
        "private, no-store",
      );

      const policy = getPublicHandlerCachePolicy(route.handler);
      if (policy?.kind !== "public") {
        continue;
      }
      observedPublicHeaders[routeName] = `public, max-age=${policy.maxAge}${
        policy.swr === undefined ? "" : `, stale-while-revalidate=${policy.swr}`
      }`;
    }

    expect(observedPublicHeaders).toEqual(PUBLIC_CACHE_HEADERS);
  });

  test("OAuth discovery is shareable across origins on the actual API", async () => {
    const origin = "https://client.example.test";
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      // A third-party client's preflight is answered for any origin, admits
      // the protocol header MCP clients send, and may be reused.
      const preflight = await api.handle(
        new Request(`http://localhost${path}`, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "mcp-protocol-version",
          },
        }),
      );
      expect(preflight.status, path).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin"), path).toBe(
        "*",
      );
      expect(
        preflight.headers
          .get("Access-Control-Allow-Headers")
          ?.toLowerCase()
          .split(", "),
        path,
      ).toContain("mcp-protocol-version");
      expect(preflight.headers.get("Access-Control-Max-Age"), path).not.toBe(
        null,
      );

      // One representation for every origin: no `Vary: Origin` to split a
      // shared cache, and no credential flag beside the wildcard origin.
      const document = await api.handle(
        new Request(`http://localhost${path}`, { headers: { origin } }),
      );
      expect(document.status, path).toBe(200);
      expect(document.headers.get("Cache-Control"), path).toBe(
        DISCOVERY_CACHE_HEADER,
      );
      expect(document.headers.get("Access-Control-Allow-Origin"), path).toBe(
        "*",
      );
      expect(document.headers.get("Vary"), path).toBeNull();
      expect(
        document.headers.get("Access-Control-Allow-Credentials"),
        path,
      ).toBeNull();
    }
  });

  test("authentication failures stay private on the actual API", async () => {
    const response = await api.handle(
      new Request("http://localhost/v1/me/oauth-connections"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("validation errors on a shared-cache route stay private", async () => {
    const previous = env.FEATURE_PUBLIC_KNOWLEDGE;
    env.FEATURE_PUBLIC_KNOWLEDGE = true;
    try {
      const response = await api.handle(
        new Request(
          `http://localhost/v1/public/knowledge/playbook-starters/${"x".repeat(65)}`,
        ),
      );
      expect(response.status).toBe(422);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    } finally {
      env.FEATURE_PUBLIC_KNOWLEDGE = previous;
    }
  });

  test("successful public knowledge keeps exactly its approved cache header", async () => {
    const previous = env.FEATURE_PUBLIC_KNOWLEDGE;
    env.FEATURE_PUBLIC_KNOWLEDGE = true;
    try {
      const response = await api.handle(
        new Request("http://localhost/v1/public/knowledge/playbook-starters"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe(
        PUBLIC_CACHE_HEADERS["GET /v1/public/knowledge/playbook-starters"],
      );
    } finally {
      env.FEATURE_PUBLIC_KNOWLEDGE = previous;
    }
  });

  test("disabled public knowledge stays private before the handler runs", async () => {
    const previous = env.FEATURE_PUBLIC_KNOWLEDGE;
    env.FEATURE_PUBLIC_KNOWLEDGE = false;
    try {
      const response = await api.handle(
        new Request("http://localhost/v1/public/knowledge/playbook-starters"),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    } finally {
      env.FEATURE_PUBLIC_KNOWLEDGE = previous;
    }
  });
});
