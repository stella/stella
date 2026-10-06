import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { bridgeOauthUiRedirect } from "@/api/lib/oauth-ui-fragment";
import api from "@/api/server";

import {
  AUTHENTICATED_PROBES,
  type CanaryFetcher,
  createJsonRpcRequest,
  createDeploymentFetcher,
  evaluateAuthorizationMetadata,
  evaluateAuthorize,
  evaluateCredentialExpiry,
  evaluateDesktopRedeem,
  evaluateDiscovery,
  evaluateInitialize,
  evaluateStreamAvailability,
  evaluateToolsList,
  evaluateRegistration,
  evaluateToolCall,
  evaluateUnauthenticated,
  LOOPBACK_REDIRECTS,
  CANARY_CLIENT_IDS,
  runDesktopProbe,
  runStagingCredentialJourneys,
  runOAuthJourneys,
  runAuthenticatedStreamProbe,
  runNamedProbe,
  summarize,
} from "./mcp-canary";

describe("canary protocol routing", () => {
  test("modern tool calls pass the installed SDK header gate", async () => {
    let calls = 0;
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({
          name: "canary-fixture",
          version: "1.0.0",
        });
        server.registerTool(
          "search_case_law",
          { inputSchema: fromJsonSchema({ type: "object", properties: {} }) },
          () => {
            calls += 1;
            return { content: [{ type: "text" as const, text: "ok" }] };
          },
        );
        return server;
      },
      { legacy: "reject", responseMode: "json" },
    );
    const call = () =>
      createJsonRpcRequest({
        baseUrl: "https://api.example",
        era: "modern",
        id: 3,
        method: "tools/call",
        params: { name: "search_case_law", arguments: {} },
        token: "token",
      });
    try {
      const valid = call();
      expect(valid.headers.get("mcp-name")).toBe("search_case_law");
      const response = await handler.fetch(valid);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { content: [{ type: "text", text: "ok" }] },
      });
      expect(calls).toBe(1);
      for (const name of [null, "another_tool"]) {
        const invalid = call();
        if (name === null) {
          invalid.headers.delete("mcp-name");
        } else {
          invalid.headers.set("mcp-name", name);
        }
        const refused = await handler.fetch(invalid);
        expect(refused.status).toBe(400);
        await refused.body?.cancel();
        expect(calls).toBe(1);
      }
    } finally {
      await handler.close();
    }
  });

  test("keeps the compatibility handshake legacy and sends tools/list through the modern handler", async () => {
    const legacyInitialize = createJsonRpcRequest({
      baseUrl: "https://api.example",
      era: "legacy",
      id: 1,
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      },
      token: "token",
    });
    const modernToolsList = createJsonRpcRequest({
      baseUrl: "https://api.example",
      era: "modern",
      id: 2,
      method: "tools/list",
      params: {},
      token: "token",
    });

    expect(await isLegacyRequest(legacyInitialize)).toBe(true);
    expect(await isLegacyRequest(modernToolsList)).toBe(false);
  });
});

describe("evaluateStreamAvailability", () => {
  test("passes an authenticated event stream", () => {
    expect(
      evaluateStreamAvailability({
        contentType: "text/event-stream; charset=utf-8",
        status: 200,
      }).status,
    ).toBe("passed");
  });

  test("fails the 405 that ChatGPT treats as a dead connector", () => {
    expect(
      evaluateStreamAvailability({
        contentType: "application/json",
        status: 405,
      }).status,
    ).toBe("failed");
  });

  test("fails a 200 without the event-stream media type", () => {
    expect(
      evaluateStreamAvailability({
        contentType: "application/json",
        status: 200,
      }).status,
    ).toBe("failed");
  });
});

describe("authenticated notification-stream probe", () => {
  test("sends the production GET and cancels a stream that remains open", async () => {
    let cancelled = false;
    let requestHeaders: Headers | undefined;
    let requestMethod: string | undefined;
    let requestPath: string | undefined;
    const fetcher: CanaryFetcher = async (input, init) => {
      requestHeaders = new Headers(init.headers);
      requestMethod = init.method;
      requestPath = new URL(input instanceof Request ? input.url : input)
        .pathname;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            cancelled = true;
          },
        }),
        {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        },
      );
    };

    const result = await runAuthenticatedStreamProbe(
      { baseUrl: "https://api.example", token: "canary-token" },
      fetcher,
    );

    expect(result.status).toBe("passed");
    expect(requestPath).toBe("/mcp");
    expect(requestMethod).toBe("GET");
    expect(requestHeaders?.get("accept")).toBe("text/event-stream");
    expect(requestHeaders?.get("authorization")).toBe("Bearer canary-token");
    expect(cancelled).toBe(true);
  });

  test("fails a 200 event-stream body that has already completed", async () => {
    const fetcher: CanaryFetcher = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.close();
          },
        }),
        {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        },
      );

    const result = await runAuthenticatedStreamProbe(
      { baseUrl: "https://api.example", token: "canary-token" },
      fetcher,
    );

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("completed");
  });

  test("fails when closing the probe stream fails", async () => {
    const fetcher: CanaryFetcher = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: async () => {
            throw new Error("synthetic cancellation failure");
          },
        }),
        {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        },
      );

    const result = await runAuthenticatedStreamProbe(
      { baseUrl: "https://api.example", token: "canary-token" },
      fetcher,
    );

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("cancellation failed");
  });
});

describe("evaluateInitialize", () => {
  test("fails a JSON-RPC error riding inside a 200", () => {
    const result = evaluateInitialize({
      body: {
        error: { code: -32_000, message: "Internal error" },
        id: 1,
        jsonrpc: "2.0",
      },
      status: 200,
    });

    expect(result.status).toBe("failed");
  });

  test("fails a 200 whose result never negotiated a session", () => {
    expect(
      evaluateInitialize({ body: { jsonrpc: "2.0", result: {} }, status: 200 })
        .status,
    ).toBe("failed");
  });

  test("passes a negotiated session", () => {
    const result = evaluateInitialize({
      body: {
        jsonrpc: "2.0",
        result: {
          capabilities: {},
          protocolVersion: "2025-11-25",
          serverInfo: { name: "stella", version: "0.1.0" },
        },
      },
      status: 200,
    });

    expect(result.status).toBe("passed");
  });
});

describe("evaluateToolsList", () => {
  test("fails an empty tool list, the shape a scope regression takes", () => {
    const result = evaluateToolsList({
      body: { jsonrpc: "2.0", result: { tools: [] } },
      status: 200,
    });

    expect(result.status).toBe("failed");
  });

  test("reports how many tools the session can see", () => {
    const result = evaluateToolsList({
      body: {
        jsonrpc: "2.0",
        result: {
          tools: [{ name: "list_matters" }, { name: "search_documents" }],
        },
      },
      status: 200,
    });

    expect(result.status).toBe("passed");
    expect(result.detail).toContain("2 tools");
  });
});

describe("evaluateUnauthenticated", () => {
  test("fails a 401 that carries no authorization-server challenge", () => {
    // Without the challenge a client cannot find the authorization server, so
    // every new connector strands at sign-in while the endpoint looks up.
    const result = evaluateUnauthenticated({
      status: 401,
      wwwAuthenticate: null,
    });

    expect(result.status).toBe("failed");
  });

  test("fails when an anonymous call is answered instead of rejected", () => {
    expect(
      evaluateUnauthenticated({ status: 200, wwwAuthenticate: null }).status,
    ).toBe("failed");
  });

  test("passes a challenge-carrying rejection", () => {
    expect(
      evaluateUnauthenticated({
        status: 401,
        wwwAuthenticate:
          'Bearer resource_metadata="https://api.example/.well-known"',
      }).status,
    ).toBe("passed");
  });
});

describe("evaluateDiscovery", () => {
  test("fails a 200 that advertises no authorization server", () => {
    expect(
      evaluateDiscovery({
        body: { resource: "https://api.example/mcp" },
        status: 200,
      }).status,
    ).toBe("failed");
  });

  test("passes a well-formed metadata document", () => {
    expect(
      evaluateDiscovery({
        body: {
          authorization_servers: ["https://auth.example"],
          resource: "https://api.example/mcp",
        },
        status: 200,
      }).status,
    ).toBe("passed");
  });
});

describe("skip reporting", () => {
  test("labels every declared probe distinctly", () => {
    // Execution and the skip report both read AUTHENTICATED_PROBES, so they
    // cannot drift. What a shared list cannot prevent is two probes sharing a
    // label, which would make a skip line ambiguous about what ran.
    const names = AUTHENTICATED_PROBES.map(({ name }) => name);

    expect(new Set(names).size).toBe(names.length);
  });

  test("keeps a skipped probe out of the failure count but visible", () => {
    const summary = summarize([
      { detail: "405", name: "a", status: "passed" },
      { detail: "no token", name: "b", status: "skipped" },
      { detail: "200 text/event-stream", name: "c", status: "failed" },
    ]);

    expect(summary).toEqual({ failed: 1, skipped: 1 });
  });
});

describe("probe failure reporting", () => {
  test("attributes a timeout to its probe without printing exception details", async () => {
    const result = await runNamedProbe("GET /mcp", async () => {
      throw new DOMException(
        "request URL and credentials must not reach diagnostics",
        "TimeoutError",
      );
    });

    expect(result).toEqual({
      detail: "request timed out after 20000 ms",
      name: "GET /mcp",
      status: "failed",
    });
  });

  test.each([
    [
      "an abort",
      new DOMException("credentials must not reach diagnostics", "AbortError"),
      "request was aborted",
    ],
    [
      "a network failure",
      new TypeError("credentials must not reach diagnostics"),
      "network request failed",
    ],
    [
      "an unknown thrown value",
      "credentials must not reach diagnostics",
      "probe threw an unknown error",
    ],
  ] as const)(
    "attributes %s to its probe without printing exception details",
    async (_classification, error, detail) => {
      const result = await runNamedProbe("GET /mcp", async () => {
        // oxlint-disable-next-line typescript/only-throw-error -- exercises the unknown rejection branch
        throw error;
      });

      expect(result).toEqual({
        detail,
        name: "GET /mcp",
        status: "failed",
      });
    },
  );
});

const oauthMetadata = {
  authorization_endpoint: "https://api.example/oauth/authorize",
  token_endpoint: "https://api.example/oauth/token",
  registration_endpoint: "https://api.example/oauth/register",
  code_challenge_methods_supported: ["S256"],
};

describe("authorization server probes", () => {
  test("requires all endpoints and PKCE S256 in authorization metadata", () => {
    expect(
      evaluateAuthorizationMetadata({ body: oauthMetadata, status: 200 })
        .status,
    ).toBe("passed");
    expect(
      evaluateAuthorizationMetadata({
        body: { ...oauthMetadata, code_challenge_methods_supported: ["plain"] },
        status: 200,
      }).status,
    ).toBe("failed");
    expect(
      evaluateAuthorizationMetadata({
        body: { ...oauthMetadata, registration_endpoint: undefined },
        status: 200,
      }).status,
    ).toBe("failed");
  });

  test("accepts only the signed browser sign-in bridge on the configured frontend origin", () => {
    const endpoint = oauthMetadata.authorization_endpoint;
    const frontendUrl = "https://app.example";
    const accepts = (location: string) =>
      evaluateAuthorize({
        endpoint,
        name: "authorize test",
        response: new Response(null, { status: 302, headers: { location } }),
        frontendUrl,
      });
    const bridgedLocation = bridgeOauthUiRedirect({
      authOrigin: "https://api.example",
      frontendUrl,
      location: "/oauth-ui/auth?sig=signed-query",
    });
    expect(bridgedLocation).not.toBeNull();
    expect(accepts(bridgedLocation ?? "").status).toBe("passed");
    expect(
      accepts("https://elsewhere.example/auth#oauth_query=sig%3Dopaque").status,
    ).toBe("failed");
    expect(accepts("https://app.example/auth").status).toBe("failed");
    expect(
      evaluateAuthorize({
        endpoint,
        name: "authorize test",
        response: new Response("blocked", { status: 200 }),
        frontendUrl,
      }).status,
    ).toBe("failed");
    expect(
      evaluateAuthorize({
        endpoint,
        name: "authorize test",
        response: new Response("WAF denied", { status: 403 }),
        frontendUrl,
      }).status,
    ).toBe("failed");
    expect(
      accepts("https://app.example/unrelated#oauth_query=sig%3Dopaque").status,
    ).toBe("failed");
  });

  test("accepts successful client registration only when it returns an id", () => {
    expect(
      evaluateRegistration({ status: 201, body: { client_id: "registered" } })
        .status,
    ).toBe("passed");
    expect(evaluateRegistration({ status: 200, body: {} }).status).toBe(
      "failed",
    );
    expect(
      evaluateRegistration({ status: 500, body: { client_id: "registered" } })
        .status,
    ).toBe("failed");
  });

  test("rejects JSON-RPC tool errors and empty content carried by HTTP 200", () => {
    const result = (body: unknown) => evaluateToolCall({ status: 200, body });
    expect(
      result({
        jsonrpc: "2.0",
        result: { content: [{ type: "text", text: "ok" }] },
      }).status,
    ).toBe("passed");
    expect(
      result({
        jsonrpc: "2.0",
        result: { isError: true, content: [{ type: "text", text: "failed" }] },
      }).status,
    ).toBe("failed");
    expect(result({ jsonrpc: "2.0", result: { content: [] } }).status).toBe(
      "failed",
    );
  });
});

describe("OAuth client journeys", () => {
  const fakeOAuth = () => {
    const requests: { url: URL; init: Parameters<CanaryFetcher>[1] }[] = [];
    const fetcher: CanaryFetcher = async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : input);
      requests.push({ url: requestUrl, init });
      if (requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          authorization_servers: ["https://api.example"],
          resource: "https://api.example/mcp",
        });
      }
      if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json(oauthMetadata);
      }
      if (requestUrl.pathname === "/oauth/register") {
        return Response.json({ client_id: "dynamic-client" }, { status: 201 });
      }
      if (requestUrl.pathname === "/oauth/authorize") {
        const location = bridgeOauthUiRedirect({
          authOrigin: "https://api.example",
          frontendUrl: "https://app.example",
          location: "/oauth-ui/auth?sig=signed",
        });
        return new Response(null, {
          status: 302,
          headers: { location: location ?? "" },
        });
      }
      return new Response(null, { status: 404 });
    };
    return { fetcher, requests };
  };

  test("frequent mode checks two clients across every loopback without registering", async () => {
    const { fetcher, requests } = fakeOAuth();
    const results = await runOAuthJourneys(
      {
        baseUrl: "https://api.example",
        frontendUrl: "https://app.example",
        mode: "frequent",
      },
      fetcher,
    );
    expect(results).toHaveLength(
      1 + CANARY_CLIENT_IDS.length * LOOPBACK_REDIRECTS.length,
    );
    expect(results.every(({ status }) => status === "passed")).toBe(true);
    expect(
      requests.filter(({ url }) => url.pathname === "/oauth/authorize"),
    ).toHaveLength(6);
    expect(requests.some(({ url }) => url.pathname === "/oauth/register")).toBe(
      false,
    );
    const authorizationRequests = requests.filter(
      ({ url }) => url.pathname === "/oauth/authorize",
    );
    const expectedPairs = new Set(
      CANARY_CLIENT_IDS.flatMap((clientId) =>
        LOOPBACK_REDIRECTS.map((redirectUri) => `${clientId}\n${redirectUri}`),
      ),
    );
    const actualPairs = new Set(
      authorizationRequests.map(
        ({ url }) =>
          `${String(url.searchParams.get("client_id"))}\n${String(url.searchParams.get("redirect_uri"))}`,
      ),
    );
    expect(actualPairs).toEqual(expectedPairs);
    for (const { url } of authorizationRequests) {
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    }
  });

  test("full mode registers once and checks the dynamic client across loopbacks", async () => {
    const { fetcher, requests } = fakeOAuth();
    const results = await runOAuthJourneys(
      {
        baseUrl: "https://api.example",
        frontendUrl: "https://app.example",
        mode: "full",
      },
      fetcher,
    );
    expect(results).toHaveLength(
      2 + (CANARY_CLIENT_IDS.length + 1) * LOOPBACK_REDIRECTS.length,
    );
    expect(results.every(({ status }) => status === "passed")).toBe(true);
    expect(
      requests.filter(({ url }) => url.pathname === "/oauth/register"),
    ).toHaveLength(1);
    const authorizationRequests = requests.filter(
      ({ url }) => url.pathname === "/oauth/authorize",
    );
    const expectedPairs = new Set(
      [...CANARY_CLIENT_IDS, "dynamic-client"].flatMap((clientId) =>
        LOOPBACK_REDIRECTS.map((redirectUri) => `${clientId}\n${redirectUri}`),
      ),
    );
    const actualPairs = new Set(
      authorizationRequests.map(
        ({ url }) =>
          `${String(url.searchParams.get("client_id"))}\n${String(url.searchParams.get("redirect_uri"))}`,
      ),
    );
    expect(actualPairs).toEqual(expectedPairs);
    expect(authorizationRequests).toHaveLength(expectedPairs.size);
    const registration = requests.find(
      ({ url }) => url.pathname === "/oauth/register",
    );
    expect(registration).toBeDefined();
    expect(await new Response(registration?.init.body).json()).toMatchObject({
      redirect_uris: LOOPBACK_REDIRECTS,
    });
  });
});

describe("desktop handoff probes", () => {
  const identity = { userId: "user-1", organizationId: "org-1" };

  test("accepts only a connected redemption for the expected account identity", () => {
    expect(
      evaluateDesktopRedeem({
        status: 200,
        body: { status: "connected", identity },
        identity,
      }).status,
    ).toBe("passed");
    expect(
      evaluateDesktopRedeem({
        status: 200,
        body: {
          status: "connected",
          identity: { ...identity, userId: "other" },
        },
        identity,
      }).status,
    ).toBe("failed");
    expect(
      evaluateDesktopRedeem({
        status: 500,
        body: { status: "error", identity },
        identity,
      }).status,
    ).toBe("failed");
  });

  const sessionResponse = () =>
    Response.json({
      user: { id: identity.userId },
      session: { activeOrganizationId: identity.organizationId },
    });

  test("mints, redeems, and revokes a per-run desktop credential", async () => {
    const requests: { path: string; headers: Headers; body: string }[] = [];
    let redeemCount = 0;
    const fetcher: CanaryFetcher = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init.headers);
      const body = await new Response(init.body).text();
      requests.push({ path: url.pathname, headers, body });
      if (url.pathname === "/api/auth/get-session") {
        return sessionResponse();
      }
      if (url.pathname.endsWith("/grant")) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/redeem-link")) {
        redeemCount += 1;
        return redeemCount === 1
          ? Response.json({ status: "credential", key: "new-desktop-key" })
          : Response.json({ status: "connected", identity });
      }
      if (url.pathname.endsWith("/request")) {
        return Response.json({ revoked: true });
      }
      return new Response(null, { status: 404 });
    };
    const results = await runDesktopProbe(
      { baseUrl: "https://api.example", sessionCookie: "session=smoke" },
      fetcher,
    );
    expect(results.map(({ status }) => status)).toEqual(["passed", "passed"]);
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/auth/get-session",
      "/v1/desktop-registry/grant",
      "/v1/desktop-registry/redeem-link",
      "/v1/desktop-registry/grant",
      "/v1/desktop-registry/redeem-link",
      "/v1/desktop-registry/request",
    ]);
    expect(requests[1]?.headers.get("cookie")).toBe("session=smoke");
    expect(requests[4]?.headers.get("authorization")).toBe(
      "Bearer new-desktop-key",
    );
    expect(JSON.parse(requests[5]?.body ?? "{}")).toEqual({ type: "revoke" });
  });

  test.each([
    "malformed response with key",
    "second grant throws",
    "second redeem throws",
  ] as const)(
    "revokes the minted desktop credential after %s",
    async (failure) => {
      const requests: { path: string; headers: Headers }[] = [];
      let redeemCount = 0;
      let grantCount = 0;
      const fetcher: CanaryFetcher = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const headers = new Headers(init.headers);
        requests.push({ path: url.pathname, headers });
        if (url.pathname === "/api/auth/get-session") {
          return sessionResponse();
        }
        if (url.pathname.endsWith("/grant")) {
          grantCount += 1;
          if (failure === "second grant throws" && grantCount === 2) {
            throw new TypeError("synthetic grant failure");
          }
          return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith("/redeem-link")) {
          redeemCount += 1;
          if (redeemCount === 1) {
            return Response.json(
              failure === "malformed response with key"
                ? { status: "unexpected", key: "new-desktop-key" }
                : { status: "credential", key: "new-desktop-key" },
            );
          }
          if (failure === "second redeem throws") {
            throw new TypeError("synthetic redeem failure");
          }
        }
        if (url.pathname.endsWith("/request")) {
          return Response.json({ revoked: true });
        }
        return Response.json({ status: "connected", identity });
      };
      const results = await runDesktopProbe(
        { baseUrl: "https://api.example", sessionCookie: "session=smoke" },
        fetcher,
      );
      expect(results.at(0)?.status).toBe("failed");
      expect(results.at(-1)?.name).toBe("desktop credential cleanup");
      expect(results.at(-1)?.status).toBe("passed");
      expect(requests.at(-1)?.path).toBe("/v1/desktop-registry/request");
      expect(requests.at(-1)?.headers.get("authorization")).toBe(
        "Bearer new-desktop-key",
      );
    },
  );

  test("reports a failed desktop credential cleanup", async () => {
    let redemption = 0;
    const fetcher: CanaryFetcher = async (input) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      if (path === "/api/auth/get-session") {
        return sessionResponse();
      }
      if (path.endsWith("/grant")) {
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/redeem-link")) {
        redemption += 1;
        return redemption === 1
          ? Response.json({ status: "credential", key: "key" })
          : Response.json({ status: "connected", identity });
      }
      return Response.json({ revoked: false }, { status: 500 });
    };
    const results = await runDesktopProbe(
      { baseUrl: "https://api.example", sessionCookie: "session=smoke" },
      fetcher,
    );
    expect(results.at(-1)).toMatchObject({
      name: "desktop credential cleanup",
      status: "failed",
    });
  });
});

describe("staging credential journeys", () => {
  const identity = { userId: "user-1", organizationId: "org-1" };

  test("skips staging credential journeys without the smoke secret", async () => {
    const results = await runStagingCredentialJourneys(
      { baseUrl: "https://api.example" },
      async () => {
        throw new Error("fetch should not run");
      },
    );
    expect(results[0]).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("SMOKE_SESSION_SECRET"),
    });
    expect(results.every(({ status }) => status === "skipped")).toBe(true);
  });

  // A staging deployment that answers every request of a passing journey.
  const createStagingDeployment = () => {
    const requests: {
      path: string;
      method: string;
      headers: Headers;
      body: string;
    }[] = [];
    let redeemCount = 0;
    const fetcher: CanaryFetcher = async (input, init) => {
      const request =
        input instanceof Request
          ? input
          : new Request(input.toString(), {
              ...init,
              signal: init.signal ?? null,
            });
      const url = new URL(request.url);
      const body = await request.clone().text();
      const headers = new Headers(request.headers);
      requests.push({
        path: url.pathname,
        method: request.method,
        headers,
        body,
      });
      if (url.pathname === "/smoke/session") {
        return Response.json({
          cookieName: "session",
          cookieValue: "staging-session",
        });
      }
      if (url.pathname === "/v1/api-keys/") {
        return Response.json({ id: "mcp-key-id", key: "mcp-token" });
      }
      if (url.pathname === "/api/auth/get-session") {
        return Response.json({
          user: { id: identity.userId },
          session: { activeOrganizationId: identity.organizationId },
        });
      }
      if (url.pathname.endsWith("/grant")) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/redeem-link")) {
        redeemCount += 1;
        return redeemCount === 1
          ? Response.json({ status: "credential", key: "desktop-token" })
          : Response.json({ status: "connected", identity });
      }
      if (url.pathname === "/v1/desktop-registry/request") {
        return Response.json({ revoked: true });
      }
      if (url.pathname === "/v1/api-keys/revoke") {
        return Response.json({ id: "mcp-key-id", revoked: true });
      }
      if (url.pathname === "/mcp" && request.method === "GET") {
        return new Response(new ReadableStream<Uint8Array>({}), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/mcp") {
        const rpc = JSON.parse(body);
        switch (rpc.method) {
          case "initialize":
            return Response.json({
              jsonrpc: "2.0",
              result: {
                protocolVersion: "2025-11-25",
                serverInfo: { name: "stella" },
              },
            });
          case "tools/list":
            return Response.json({
              jsonrpc: "2.0",
              result: { tools: [{ name: "search_case_law" }] },
            });
          default:
            return Response.json({
              jsonrpc: "2.0",
              result: { content: [{ type: "text", text: "ok" }] },
            });
        }
      }
      return new Response(null, { status: 404 });
    };
    return { requests, fetcher };
  };

  test("runs MCP and desktop probes with short-lived credentials, then revokes the MCP key", async () => {
    const { requests, fetcher } = createStagingDeployment();
    const results = await runStagingCredentialJourneys(
      { baseUrl: "https://api.example", smokeSecret: "smoke-secret" },
      fetcher,
    );
    expect(
      results
        .filter(
          ({ name }) =>
            name.startsWith("POST /mcp") ||
            name.startsWith("GET /mcp") ||
            name === "desktop handoff redeem",
        )
        .every(({ status }) => status === "passed"),
    ).toBe(true);
    expect(results.at(-1)).toMatchObject({
      name: "MCP credential cleanup",
      status: "passed",
    });
    const bootstrap = requests.find(({ path }) => path === "/v1/api-keys/");
    expect(JSON.parse(bootstrap?.body ?? "{}")).toEqual({
      name: "MCP staging canary",
      scopes: ["stella:search", "stella:read"],
      permissions: { workspace: ["read"] },
      audience: "default",
      expiresInDays: 1,
    });
    expect(bootstrap?.headers.get("cookie")).toBe("session=staging-session");
    expect(
      requests
        .filter(({ path }) => path === "/mcp")
        .every(
          ({ headers }) => headers.get("authorization") === "Bearer mcp-token",
        ),
    ).toBe(true);
    const revoke = requests.find(({ path }) => path === "/v1/api-keys/revoke");
    expect(JSON.parse(revoke?.body ?? "{}")).toEqual({ keyId: "mcp-key-id" });
  });

  // The stand-in deployment answers whatever path it is asked, so only the
  // real router can tell whether each journey request reaches a route.
  test("requests only routes the API mounts", async () => {
    const { requests, fetcher } = createStagingDeployment();
    await runStagingCredentialJourneys(
      { baseUrl: "https://api.example", smokeSecret: "smoke-secret" },
      fetcher,
    );
    const mounted = api.routes
      // The Better Auth catch-all matches any path; its own prefix is
      // checked separately below.
      .filter(({ path }) => path !== "/*")
      .map(({ method, path }) => ({
        method,
        pattern: new RegExp(
          `^${path
            .replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&")
            .replaceAll(/:[^/]+/gu, "[^/]+")
            .replaceAll("*", ".*")}$`,
          "u",
        ),
      }));
    const unrouted = requests
      .filter(({ path }) => !path.startsWith("/api/auth/"))
      .filter(
        ({ method, path }) =>
          !mounted.some(
            (route) =>
              (route.method === method || route.method === "ALL") &&
              route.pattern.test(path),
          ),
      )
      .map(({ method, path }) => `${method} ${path}`);
    expect(requests.map(({ path }) => path)).toContain("/smoke/session");
    expect(unrouted).toEqual([]);
  });

  test("revokes an MCP key id returned alongside a malformed bootstrap response", async () => {
    const requests: { path: string; body: string }[] = [];
    const fetcher: CanaryFetcher = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({
        path: url.pathname,
        body: await new Response(init.body).text(),
      });
      if (url.pathname === "/smoke/session") {
        return Response.json({ cookieName: "session", cookieValue: "session" });
      }
      if (url.pathname === "/v1/api-keys/") {
        return Response.json({ id: "partial-id" });
      }
      if (url.pathname === "/v1/api-keys/revoke") {
        return Response.json({ id: "partial-id", revoked: true });
      }
      return new Response(null, { status: 500 });
    };
    const results = await runStagingCredentialJourneys(
      { baseUrl: "https://api.example", smokeSecret: "secret" },
      fetcher,
    );
    expect(
      results.find(({ name }) => name === "staging credential bootstrap")
        ?.status,
    ).toBe("failed");
    expect(
      requests.some(
        ({ path, body }) =>
          path === "/v1/api-keys/revoke" && body.includes("partial-id"),
      ),
    ).toBe(true);
  });

  test("reports MCP credential cleanup failures", async () => {
    const fetcher: CanaryFetcher = async (input) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      if (path === "/smoke/session") {
        return Response.json({ cookieName: "session", cookieValue: "session" });
      }
      if (path === "/v1/api-keys/") {
        return Response.json({ id: "key-id", key: "token" });
      }
      if (path === "/v1/api-keys/revoke") {
        return Response.json({ revoked: false }, { status: 500 });
      }
      if (path === "/mcp" && input instanceof URL) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    };
    const results = await runStagingCredentialJourneys(
      { baseUrl: "https://api.example", smokeSecret: "secret" },
      fetcher,
    );
    expect(results.at(-1)).toMatchObject({
      name: "MCP credential cleanup",
      status: "failed",
    });
  });
});

describe("canary credential expiry", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const expires = (days: number) =>
    new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();

  test.each([
    [16, "passed"],
    [15, "failed"],
    [14, "failed"],
    [-1, "failed"],
  ] as const)("classifies expiry at %s days", (days, status) => {
    expect(
      evaluateCredentialExpiry({
        status: 200,
        body: { expiresAt: expires(days) },
        nowMs,
      }).status,
    ).toBe(status);
  });

  test("passes credentials with no expiry and fails malformed or unavailable expiry", () => {
    expect(
      evaluateCredentialExpiry({
        status: 200,
        body: { expiresAt: null },
        nowMs,
      }).status,
    ).toBe("passed");
    expect(
      evaluateCredentialExpiry({
        status: 200,
        body: { expiresAt: "not-a-date" },
        nowMs,
      }).status,
    ).toBe("failed");
    expect(
      evaluateCredentialExpiry({ status: 200, body: null, nowMs }).status,
    ).toBe("failed");
    expect(
      evaluateCredentialExpiry({
        status: 503,
        body: { expiresAt: null },
        nowMs,
      }).status,
    ).toBe("failed");
  });
});

describe("canary credential expiry failure detail", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

  test.each([
    [404, "HTTP 404: the target does not serve the key expiry endpoint yet"],
    [401, "HTTP 401: the target refused MCP_CANARY_TOKEN"],
    [403, "HTTP 403: could not inspect the current machine key expiry"],
    [503, "HTTP 503: could not inspect the current machine key expiry"],
    [200, "HTTP 200: could not inspect the current machine key expiry"],
  ] as const)("names HTTP %s in the failure", (status, detail) => {
    expect(
      evaluateCredentialExpiry({
        status,
        body: status === 200 ? { expiresAt: "not-a-date" } : null,
        nowMs,
      }),
    ).toEqual({ name: "canary bearer expiry", status: "failed", detail });
  });
});

describe("deployment fetch boundary", () => {
  test("injects the edge credential and always makes redirects manual", async () => {
    let captured: Parameters<CanaryFetcher>[1] | undefined;
    const fetcher: CanaryFetcher = async (_input, init) => {
      captured = init;
      return new Response(null, {
        status: 302,
        headers: { location: "https://foreign.example/" },
      });
    };
    const deploymentFetch = createDeploymentFetcher(
      {
        baseUrl: "https://api.example",
        edgeHeaderName: "x-edge-key",
        edgeHeaderValue: "edge-secret",
      },
      fetcher,
    );
    const response = await deploymentFetch("https://api.example/path", {
      headers: { authorization: "Bearer canary" },
      redirect: "follow",
      timeout: { type: "idle", ms: 1000 },
    });
    expect(response.status).toBe(302);
    expect(captured?.redirect).toBe("manual");
    expect(new Headers(captured?.headers).get("x-edge-key")).toBe(
      "edge-secret",
    );
  });

  test("allows the configured app origin alongside the API origin", async () => {
    const origins: string[] = [];
    const fetcher: CanaryFetcher = async (input) => {
      origins.push(
        new URL(input instanceof Request ? input.url : input).origin,
      );
      return new Response(null);
    };
    const deploymentFetch = createDeploymentFetcher(
      { baseUrl: "https://api.example", appUrl: "https://app.example" },
      fetcher,
    );
    await deploymentFetch("https://app.example/oauth/authorize", {
      timeout: { type: "idle", ms: 1000 },
    });
    await deploymentFetch("https://api.example/mcp", {
      timeout: { type: "idle", ms: 1000 },
    });
    expect(origins).toEqual(["https://app.example", "https://api.example"]);
    const rejection = await rejectionOf(
      deploymentFetch("https://foreign.example/path", {
        timeout: { type: "idle", ms: 1000 },
      }),
    );
    expect(rejection).toMatchObject({ _tag: "CanaryTargetError" });
  });

  test("rejects a foreign origin before invoking the fetcher", async () => {
    let calls = 0;
    const fetcher: CanaryFetcher = async () => {
      calls += 1;
      return new Response(null);
    };
    const deploymentFetch = createDeploymentFetcher(
      { baseUrl: "https://api.example" },
      fetcher,
    );
    const rejection = await rejectionOf(
      deploymentFetch("https://foreign.example/path", {
        timeout: { type: "idle", ms: 1000 },
      }),
    );
    expect(rejection).toMatchObject({ _tag: "CanaryTargetError" });
    expect(rejection).toMatchObject({
      message: expect.stringContaining("configured origin"),
    });
    expect(calls).toBe(0);
  });
});
