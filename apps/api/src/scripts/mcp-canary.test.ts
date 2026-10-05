import { isLegacyRequest } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { bridgeOauthUiRedirect } from "@/api/lib/oauth-ui-fragment";

import {
  AUTHENTICATED_PROBES,
  type CanaryFetcher,
  createJsonRpcRequest,
  createDeploymentFetcher,
  evaluateAuthorizationMetadata,
  evaluateAuthorize,
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
  runOAuthJourneys,
  runAuthenticatedStreamProbe,
  runNamedProbe,
  summarize,
} from "./mcp-canary";

describe("canary protocol routing", () => {
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
    const requests: { url: URL; init?: RequestInit }[] = [];
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
          `${url.searchParams.get("client_id")}\n${url.searchParams.get("redirect_uri")}`,
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
          `${url.searchParams.get("client_id")}\n${url.searchParams.get("redirect_uri")}`,
      ),
    );
    expect(actualPairs).toEqual(expectedPairs);
    expect(authorizationRequests).toHaveLength(expectedPairs.size);
    const registration = requests.find(
      ({ url }) => url.pathname === "/oauth/register",
    );
    expect(JSON.parse(String(registration?.init?.body))).toMatchObject({
      redirect_uris: LOOPBACK_REDIRECTS,
    });
  });
});

describe("desktop handoff probes", () => {
  const identity = { userId: "user-1", organizationId: "org-1" };

  test("redeem requires the connected identity to match the existing account", () => {
    expect(
      evaluateDesktopRedeem({
        status: 200,
        body: { status: "connected", identity },
        identity,
      }).status,
    ).toBe("passed");
    expect(
      evaluateDesktopRedeem({
        status: 500,
        body: { status: "error", identity },
        identity,
      }).status,
    ).toBe("failed");
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
  });

  test("skips explicitly when existing desktop credentials are absent", async () => {
    let calls = 0;
    const fetcher: CanaryFetcher = async () => {
      calls += 1;
      return Response.json({});
    };
    const result = await runDesktopProbe(
      { baseUrl: "https://api.example" },
      fetcher,
    );
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("MCP_CANARY_DESKTOP_KEY");
    expect(calls).toBe(0);
  });

  test("skips when the existing key has no browser session or smoke secret", async () => {
    let calls = 0;
    const fetcher: CanaryFetcher = async () => {
      calls += 1;
      return Response.json({});
    };
    const result = await runDesktopProbe(
      { baseUrl: "https://api.example", desktopKey: "existing-key" },
      fetcher,
    );
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain(
      "MCP_CANARY_SESSION_COOKIE or SMOKE_SESSION_SECRET",
    );
    expect(calls).toBe(0);
  });

  test("redeems using an existing key and browser session without minting a key", async () => {
    const requests: { path: string; headers: Headers; body: string }[] = [];
    const fetcher: CanaryFetcher = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init.headers);
      const body = String(init.body ?? "");
      requests.push({ path: url.pathname, headers, body });
      if (url.pathname.endsWith("/request")) {
        return Response.json({ identity });
      }
      if (url.pathname.endsWith("/grant")) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/redeem-link")) {
        return Response.json({ status: "connected", identity });
      }
      return new Response(null, { status: 404 });
    };
    const result = await runDesktopProbe(
      {
        baseUrl: "https://api.example",
        desktopKey: "existing-key",
        sessionCookie: "session=existing",
      },
      fetcher,
    );
    expect(result.status).toBe("passed");
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/desktop-registry/request",
      "/v1/desktop-registry/grant",
      "/v1/desktop-registry/redeem-link",
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer existing-key",
    );
    expect(requests[1]?.headers.get("cookie")).toBe("session=existing");
  });

  test("uses the explicit smoke secret to obtain the browser cookie for redemption", async () => {
    const requests: { path: string; headers: Headers }[] = [];
    const fetcher: CanaryFetcher = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init.headers);
      requests.push({ path: url.pathname, headers });
      if (url.pathname === "/v1/smoke/session") {
        return Response.json({
          cookieName: "session",
          cookieValue: "browser-session",
        });
      }
      if (url.pathname.endsWith("/request")) {
        return Response.json({ identity });
      }
      if (url.pathname.endsWith("/grant")) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/redeem-link")) {
        return Response.json({ status: "connected", identity });
      }
      return new Response(null, { status: 404 });
    };
    const result = await runDesktopProbe(
      {
        baseUrl: "https://api.example",
        desktopKey: "existing-key",
        smokeSecret: "smoke-secret",
      },
      fetcher,
    );
    expect(result.status).toBe("passed");
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/smoke/session",
      "/v1/desktop-registry/request",
      "/v1/desktop-registry/grant",
      "/v1/desktop-registry/redeem-link",
    ]);
    expect(requests[0]?.headers.get("x-smoke-secret")).toBe("smoke-secret");
    expect(requests[2]?.headers.get("cookie")).toBe("session=browser-session");
  });
});

describe("deployment fetch boundary", () => {
  test("injects the edge credential and always makes redirects manual", async () => {
    let captured: RequestInit | undefined;
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
    });
    expect(response.status).toBe(302);
    expect(captured?.redirect).toBe("manual");
    expect(new Headers(captured?.headers).get("x-edge-key")).toBe(
      "edge-secret",
    );
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
      deploymentFetch("https://foreign.example/path", {}),
    );
    expect(rejection).toBeInstanceOf(TypeError);
    expect(rejection).toMatchObject({
      message: expect.stringContaining("configured origin"),
    });
    expect(calls).toBe(0);
  });
});
