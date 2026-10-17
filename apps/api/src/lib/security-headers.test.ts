import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import {
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth/auth-paths";
import { createAuthResponseCookiesPlugin } from "@/api/lib/auth/auth-response-cookies";
import {
  applyDiscoveryMetadataCachePolicy,
  DISCOVERY_METADATA_PATHS,
} from "@/api/lib/auth/discovery-metadata-cache";
import {
  applyResponseCachePolicy,
  finalizeResponseCachePolicy,
  PRIVATE_CACHE_CONTROL,
  RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
  setSecurityHeaders,
} from "@/api/lib/security-headers";
import {
  MCP_RESOURCE_MODE_CONFIG,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/resource-policy-contract";

const DISCOVERY_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=3600";

const advertisedDiscoveryPaths = new Set([
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_MCP_DISCOVERY_PATH,
  ...Object.values(MCP_RESOURCE_MODE_CONFIG).map(
    ({ discoveryPath }) => discoveryPath,
  ),
]);

const discoveryPolicyApp = new Elysia()
  .mapResponse(({ responseValue, set }) =>
    finalizeResponseCachePolicy({ response: responseValue, set }),
  )
  .onRequest(({ request, set }) => {
    setSecurityHeaders(set);
    applyDiscoveryMetadataCachePolicy({ request, set });
  })
  .all("/*", ({ request, set }) => {
    if (request.headers.has("x-force-error")) {
      set.status = 404;
      return { error: "not found" };
    }
    return { ok: true };
  });

describe("discovery metadata cache policy", () => {
  test("covers every advertised discovery path", async () => {
    expect(DISCOVERY_METADATA_PATHS).toEqual(advertisedDiscoveryPaths);

    for (const path of advertisedDiscoveryPaths) {
      for (const method of ["GET", "HEAD"]) {
        const response = await discoveryPolicyApp.handle(
          new Request(`http://localhost${path}`, { method }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe(
          DISCOVERY_CACHE_CONTROL,
        );
      }
    }
  });

  test("keeps discovery errors and non-discovery responses private", async () => {
    const discoveryError = await discoveryPolicyApp.handle(
      new Request(
        `http://localhost${ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH}`,
        { headers: { "x-force-error": "true" } },
      ),
    );
    expect(discoveryError.status).toBe(404);
    expect(discoveryError.headers.get("cache-control")).toBe(
      PRIVATE_CACHE_CONTROL,
    );

    const privateResponse = await discoveryPolicyApp.handle(
      new Request("http://localhost/private"),
    );
    expect(privateResponse.status).toBe(200);
    expect(privateResponse.headers.get("cache-control")).toBe(
      PRIVATE_CACHE_CONTROL,
    );
  });
});

describe("raw document response security", () => {
  test("prevents sensitive document bytes from being cached", () => {
    const response = new Response(new Uint8Array([1]), {
      headers: RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
    });

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

test("private icon caching survives finalization while late errors remain uncacheable", () => {
  const set = { headers: {}, status: 200 };
  const response = new Blob([new Uint8Array([1])], { type: "image/png" });
  applyResponseCachePolicy({
    cache: { kind: "private", maxAge: 3600 },
    response,
    set,
  });
  finalizeResponseCachePolicy({ response, set });
  expect(new Headers(set.headers).get("cache-control")).toBe(
    "private, max-age=3600",
  );
  set.status = 500;
  finalizeResponseCachePolicy({ response, set });
  expect(new Headers(set.headers).get("cache-control")).toBe(
    "private, no-store",
  );
});

describe("response cookies prevent public caching", () => {
  test.each(["pending", "response", "cookie"] as const)(
    "keeps an otherwise public response private when a late cookie comes from %s",
    async (source) => {
      const app = new Elysia()
        .use(createAuthResponseCookiesPlugin())
        .onAfterHandle(({ set, responseValue, cookie }) => {
          if (source === "pending") {
            set.headers["set-cookie"] = "session=renewed; HttpOnly; Path=/";
          } else if (source === "cookie") {
            const sessionCookie =
              cookie["session"] ?? panic("Session cookie fixture is missing");
            sessionCookie.value = "renewed";
          } else if (responseValue instanceof Response) {
            responseValue.headers.append(
              "set-cookie",
              "session=renewed; HttpOnly; Path=/",
            );
          }
        })
        .mapResponse(({ responseValue, set }) =>
          finalizeResponseCachePolicy({ response: responseValue, set }),
        )
        .get("/", ({ set }) => {
          const response = new Response("public representation");
          expect(
            applyResponseCachePolicy({
              cache: { kind: "public", maxAge: 300 },
              response,
              set,
            }),
          ).toBe("public, max-age=300");
          return response;
        });
      const response = await app.handle(new Request("http://localhost/"));
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toHaveLength(1);
      expect(response.headers.getSetCookie().at(0)).toContain(
        "session=renewed",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  test("checks pending cookie headers without depending on header casing or raw responses", () => {
    for (const name of ["set-cookie", "Set-Cookie", "SET-COOKIE"]) {
      const set = { headers: { [name]: "session=renewed; Path=/" } };
      expect(
        applyResponseCachePolicy({
          cache: { kind: "public", maxAge: 300 },
          response: { ok: true },
          set,
        }),
      ).toBe("private, no-store");
      finalizeResponseCachePolicy({ response: { ok: true }, set });
      expect(new Headers(set.headers).get("cache-control")).toBe(
        "private, no-store",
      );
    }
  });
});
