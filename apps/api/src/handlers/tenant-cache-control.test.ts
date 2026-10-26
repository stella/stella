import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiPipeline } from "@/api/api-pipeline";
import { env } from "@/api/env";
import type { ApiRouteKey } from "@/api/http/api-route-types";
import {
  cacheControlFor,
  NO_CACHE,
  PRIVATE_CACHE_CONTROL,
  responseCachePolicy,
} from "@/api/http/cache";
import {
  MCP_MODES,
  MCP_RESOURCE_MODE_CONFIG,
} from "@/api/mcp/resource-policy-contract";
import { apiApp } from "@/api/server";
import { serveForTest } from "@/api/tests/helpers/test-server";

// TTL changes and new shared-cache routes require an explicit review decision.
const DISCOVERY_CACHE_HEADER =
  "public, max-age=300, stale-while-revalidate=3600";
const PUBLIC_CACHE_HEADERS: ReadonlyMap<ApiRouteKey, string> = new Map([
  ["GET /.well-known/oauth-authorization-server", DISCOVERY_CACHE_HEADER],
  [
    "GET /.well-known/oauth-authorization-server/api/auth",
    DISCOVERY_CACHE_HEADER,
  ],
  ["GET /.well-known/openid-configuration", DISCOVERY_CACHE_HEADER],
  ["GET /.well-known/oauth-protected-resource", DISCOVERY_CACHE_HEADER],
  ...MCP_MODES.map(
    (mode) =>
      [
        `GET ${MCP_RESOURCE_MODE_CONFIG[mode].discoveryPath}` satisfies ApiRouteKey,
        DISCOVERY_CACHE_HEADER,
      ] as const,
  ),
  ["GET /auth.md", "public, max-age=300"],
  ["GET /v1/mcp/oauth/client-metadata.json", "public, max-age=3600"],
  ["GET /v1/mcp/oauth/cli-client-metadata.json", "public, max-age=3600"],
  ["GET /v1/case/coverage", "public, max-age=900, stale-while-revalidate=3600"],
  ["GET /v1/case/judges/:judgeId/portrait", "public, max-age=86400"],
  [
    "GET /v1/law/statutes/:documentId/provisions/:anchor/preview",
    "public, max-age=3600, stale-while-revalidate=86400",
  ],
  ["GET /v1/public/knowledge/template-packs", "public, max-age=300"],
  ["GET /v1/public/knowledge/template-packs/:packId", "public, max-age=300"],
  [
    "GET /v1/public/knowledge/template-packs/:packId/templates/:templateId",
    "public, max-age=300",
  ],
  [
    "GET /v1/public/knowledge/template-packs/:packId/templates/:templateId/preview",
    "public, max-age=300",
  ],
  ["GET /v1/public/knowledge/playbook-starters", "public, max-age=300"],
  ["GET /v1/public/knowledge/playbook-starters/:id", "public, max-age=300"],
]);

describe("composed API cache policy", () => {
  test("every mounted route declares its response cache policy", () => {
    // Every answer leaves through the one stage that decides Cache-Control.
    expect(apiPipeline).toContain(responseCachePolicy);
    expect(apiApp.routes.length).toBeGreaterThan(100);
    const observedPublicHeaders: Record<string, string> = {};

    for (const route of apiApp.routes) {
      const routeName = `${route.method} ${route.path}`;
      // The policy the pipeline's cache stage reads for this route.
      const cache = route.definition.cache ?? NO_CACHE;

      // A failure, an answer that sets a cookie, and a fallback answer are
      // never kept, whatever the route declares.
      expect(
        cacheControlFor(new Response("example", { status: 500 }), {
          cache,
          privateOnly: false,
        }),
        routeName,
      ).toBe(PRIVATE_CACHE_CONTROL);
      expect(
        cacheControlFor(
          new Response("example", { headers: { "set-cookie": "a=1" } }),
          { cache, privateOnly: false },
        ),
        routeName,
      ).toBe(PRIVATE_CACHE_CONTROL);
      expect(
        cacheControlFor(new Response("example"), { cache, privateOnly: true }),
        routeName,
      ).toBe(PRIVATE_CACHE_CONTROL);

      const success = cacheControlFor(new Response("example"), {
        cache,
        privateOnly: false,
      });
      if (cache.kind !== "public") {
        expect(success, routeName).toBe(PRIVATE_CACHE_CONTROL);
        continue;
      }
      observedPublicHeaders[routeName] = success;
    }

    expect(observedPublicHeaders).toEqual(
      Object.fromEntries(PUBLIC_CACHE_HEADERS),
    );
  });

  test("OAuth discovery is shareable across origins on the actual API", async () => {
    await using api = serveForTest(apiApp);
    const origin = "https://client.example.test";
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      // A third-party client's preflight is answered for any origin, admits
      // the protocol header MCP clients send, and may be reused.
      const preflight = await api.fetch(
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
      const document = await api.fetch(
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
    await using server = serveForTest(apiApp);
    const response = await server.fetch(
      new Request("http://localhost/v1/me/oauth-connections"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("validation errors on a shared-cache route stay private", async () => {
    const previous = env.FEATURE_PUBLIC_KNOWLEDGE;
    env.FEATURE_PUBLIC_KNOWLEDGE = true;
    try {
      await using server = serveForTest(apiApp);
      const response = await server.fetch(
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
      await using server = serveForTest(apiApp);
      const response = await server.fetch(
        new Request("http://localhost/v1/public/knowledge/playbook-starters"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toEqual(
        PUBLIC_CACHE_HEADERS.get(
          "GET /v1/public/knowledge/playbook-starters" satisfies ApiRouteKey,
        ) ?? panic("Public playbook starters must declare their cache header"),
      );
    } finally {
      env.FEATURE_PUBLIC_KNOWLEDGE = previous;
    }
  });

  test("disabled public knowledge stays private before the handler runs", async () => {
    const previous = env.FEATURE_PUBLIC_KNOWLEDGE;
    env.FEATURE_PUBLIC_KNOWLEDGE = false;
    try {
      await using server = serveForTest(apiApp);
      const response = await server.fetch(
        new Request("http://localhost/v1/public/knowledge/playbook-starters"),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    } finally {
      env.FEATURE_PUBLIC_KNOWLEDGE = previous;
    }
  });
});
