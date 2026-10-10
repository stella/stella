import { describe, expect, test } from "bun:test";

import { sha256Base64Url } from "@stll/sha256/bun";

import { type CanaryFetcher, runRefreshJourney, summarize } from "./mcp-canary";

const BASE_URL = "https://api.example";
const FRONTEND_URL = "https://app.example";
const OPTIONS = {
  baseUrl: BASE_URL,
  frontendUrl: FRONTEND_URL,
  environment: "staging",
  smokeSecret: "smoke-fixture-secret",
} as const;
const PRODUCTION_OPTIONS = {
  ...OPTIONS,
  environment: "production",
  configuredBaseUrl: BASE_URL,
  email: "restricted@example.test",
  password: "password-fixture-secret",
} as const;
const STEPS = [
  "bootstrap",
  "discovery",
  "authorize",
  "consent",
  "token",
  ...[1, 2, 3].flatMap((round) => [
    `refresh ${String(round)}`,
    `refresh ${String(round)} replay`,
    `successor ${String(round)} initialize`,
    `successor ${String(round)} read`,
  ]),
] as const;

type FixtureOptions = {
  failure?: { step: string; kind: "http" | "transport" | "malformed" };
  repeatRefresh?: number;
  responseBody?: { step: string; body: unknown };
  wrongCallbackState?: boolean;
  callbackIssuer?: string | null;
  metadataIssuer?: string;
};

const createTransport = ({
  failure,
  repeatRefresh,
  responseBody,
  wrongCallbackState,
  callbackIssuer = `${BASE_URL}/api/auth`,
  metadataIssuer = `${BASE_URL}/api/auth`,
}: FixtureOptions = {}) => {
  const requests: { url: URL; headers: Headers; body: string; step: string }[] =
    [];
  let authorizeUrl: URL | undefined;
  let rotation = 0;
  const rotatedPairs = new Map<
    string,
    { access_token: string; refresh_token: string }
  >();
  const fetcher: CanaryFetcher = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname !== "/mcp") {
      expect(init.timeout).toEqual({ type: "idle", ms: 10_000 });
      expect(init.signal?.aborted).toBe(false);
    }
    const headers = new Headers(init.headers ?? request?.headers);
    let body = "";
    if (typeof init.body === "string") {
      body = init.body;
    } else if (request) {
      body = await request.clone().text();
    }
    let step: string;
    let response: Response;
    switch (url.pathname) {
      case "/api/auth/sign-in/email":
        step = "sign-in";
        expect(JSON.parse(body)).toEqual({
          email: PRODUCTION_OPTIONS.email,
          password: PRODUCTION_OPTIONS.password,
        });
        response = Response.json(
          { user: { email: PRODUCTION_OPTIONS.email } },
          { headers: { "set-cookie": "session=restricted-cookie; HttpOnly" } },
        );
        break;
      case "/api/auth/get-session":
        step = "session";
        response = Response.json({
          user: { email: PRODUCTION_OPTIONS.email },
          session: { activeOrganizationId: "restricted-org" },
        });
        break;
      case "/smoke/session":
        step = "bootstrap";
        response = Response.json({
          cookieName: "session",
          cookieValue: "smoke-cookie",
        });
        break;
      case "/.well-known/oauth-protected-resource/mcp":
        step = "discovery";
        response = Response.json({
          resource: `${BASE_URL}/mcp`,
          authorization_servers: [`${BASE_URL}/api/auth`],
        });
        break;
      case "/.well-known/oauth-authorization-server/api/auth": {
        step = "discovery";
        const metadata = {
          issuer: metadataIssuer,
          authorization_endpoint: `${FRONTEND_URL}/api/auth/oauth2/authorize`,
          token_endpoint: `${FRONTEND_URL}/api/auth/oauth2/token`,
          registration_endpoint: `${FRONTEND_URL}/api/auth/oauth2/register`,
          revocation_endpoint: `${FRONTEND_URL}/api/auth/oauth2/revoke`,
          code_challenge_methods_supported: ["S256"],
        };
        response = Response.json(metadata);
        break;
      }
      case "/api/auth/oauth2/authorize":
        step = "authorize";
        authorizeUrl = url;
        response = Response.json({
          url: `${FRONTEND_URL}/consent#oauth_query=signed-query`,
        });
        break;
      case "/api/auth/oauth2/consent": {
        step = "consent";
        const callback = authorizeUrl?.searchParams.get("redirect_uri");
        const state = authorizeUrl?.searchParams.get("state");
        if (!callback || !state) {
          throw new TypeError("fixture requires authorization");
        }
        const redirect = new URL(callback);
        redirect.searchParams.set(
          "state",
          wrongCallbackState ? "wrong-state" : state,
        );
        redirect.searchParams.set("code", "fixture-code");
        if (callbackIssuer !== null) {
          redirect.searchParams.set("iss", callbackIssuer);
        }
        response = Response.json({ url: redirect.toString() });
        break;
      }
      case "/api/auth/oauth2/token": {
        const grant = new URLSearchParams(body);
        if (grant.get("grant_type") === "refresh_token") {
          const previous = grant.get("refresh_token");
          const pair = previous ? rotatedPairs.get(previous) : undefined;
          if (pair) {
            step = `refresh ${String(rotation)} replay`;
            response = Response.json(pair);
            break;
          }
          rotation += 1;
          step = `refresh ${String(rotation)}`;
          expect(grant.get("refresh_token")).toBe(
            `refresh-${String(rotation - 1)}`,
          );
        } else {
          step = "token";
          const verifier = grant.get("code_verifier");
          expect(verifier).not.toBeNull();
          expect(authorizeUrl?.searchParams.get("code_challenge")).toBe(
            sha256Base64Url(verifier ?? ""),
          );
        }
        const pair = {
          access_token: `access-${String(rotation)}`,
          refresh_token: `refresh-${String(rotation === repeatRefresh ? rotation - 1 : rotation)}`,
        };
        response = Response.json(pair);
        const previous = grant.get("refresh_token");
        if (previous) {
          rotatedPairs.set(previous, pair);
        }
        break;
      }
      case "/mcp": {
        const rpc = JSON.parse(body);
        expect(headers.get("authorization")).toBe(
          `Bearer access-${String(rotation)}`,
        );
        step = `successor ${String(rotation)} ${rpc.method === "initialize" ? "initialize" : "read"}`;
        response = Response.json({
          jsonrpc: "2.0",
          result:
            rpc.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  serverInfo: { name: "fixture" },
                }
              : { content: [{ type: "text", text: "ok" }] },
        });
        if (rpc.method !== "initialize") {
          expect(rpc.method).toBe("tools/call");
          expect(rpc.params.name).toBe("search_case_law");
        }
        break;
      }
      case "/api/auth/oauth2/revoke":
        step = "revoke";
        response = Response.json({});
        break;
      default:
        throw new TypeError("fixture received unexpected endpoint");
    }
    requests.push({ url, headers, body, step });
    if (step === responseBody?.step) {
      response = Response.json(responseBody.body);
    }
    if (step === failure?.step) {
      switch (failure.kind) {
        case "transport":
          throw new TypeError(
            "smoke-fixture-secret refresh-0 access-0 smoke-cookie",
          );
        case "http":
          return Response.json(
            { error: "invalid_grant", message: "smoke-fixture-secret" },
            { status: 400 },
          );
        case "malformed":
          return Response.json({ malformed: true });
      }
    }
    return response;
  };
  return { fetcher, requests };
};

describe("per-run OAuth refresh journey", () => {
  test("fails a callback with a different state before exchanging its code", async () => {
    const { fetcher, requests } = createTransport({ wrongCallbackState: true });
    const results = await runRefreshJourney(OPTIONS, fetcher);
    expect(results.filter(({ status }) => status === "failed")).toMatchObject([
      { name: "OAuth refresh: callback" },
    ]);
    expect(requests.some(({ step }) => step === "token")).toBe(false);
  });

  test.each(["token", "refresh 1"])(
    "revokes a returned refresh token when %s has no access token",
    async (step) => {
      const { fetcher, requests } = createTransport({
        responseBody: { step, body: { refresh_token: "partial-refresh" } },
      });
      const results = await runRefreshJourney(OPTIONS, fetcher);
      expect(results.filter(({ status }) => status === "failed")).toMatchObject(
        [{ name: `OAuth refresh: ${step}` }],
      );
      expect(new URLSearchParams(requests.at(-1)?.body).get("token")).toBe(
        "partial-refresh",
      );
      expect(requests.at(-1)?.step).toBe("revoke");
    },
  );

  test.each([1, 2, 3])(
    "fails a tool error envelope for successor %s without printing its content",
    async (round) => {
      const step = `successor ${String(round)} read`;
      const { fetcher } = createTransport({
        responseBody: {
          step,
          body: {
            jsonrpc: "2.0",
            result: {
              isError: true,
              content: [{ type: "text", text: "smoke-fixture-secret" }],
            },
          },
        },
      });
      const results = await runRefreshJourney(OPTIONS, fetcher);
      expect(results.filter(({ status }) => status === "failed")).toMatchObject(
        [{ name: `OAuth refresh: ${step}` }],
      );
      expect(JSON.stringify(results)).not.toContain("smoke-fixture-secret");
    },
  );

  test("rotates three times, reads with each successor, and revokes the final grant", async () => {
    const { fetcher, requests } = createTransport();
    const results = await runRefreshJourney(OPTIONS, fetcher);
    expect(results.map(({ name, status }) => [name, status])).toEqual(
      [...STEPS.slice(0, 4), "callback", ...STEPS.slice(4), "revoke"].map(
        (step) => [`OAuth refresh: ${step}`, "passed"],
      ),
    );
    const authorize = requests.find(({ step }) => step === "authorize");
    expect(authorize?.url.searchParams.get("scope")?.split(" ")).toContain(
      "offline_access",
    );
    expect(authorize?.url.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const revoke = requests.find(({ step }) => step === "revoke");
    expect(Object.fromEntries(new URLSearchParams(revoke?.body))).toEqual({
      client_id: `${BASE_URL}/v1/mcp/oauth/cli-client-metadata.json`,
      token: "refresh-3",
      token_type_hint: "refresh_token",
    });
    expect(summarize(results)).toEqual({ failed: 0, skipped: 0 });
    for (const { url, headers } of requests) {
      expect([BASE_URL, FRONTEND_URL]).toContain(url.origin);
      if (url.pathname.startsWith("/api/auth/oauth2/")) {
        expect(headers.get("cookie")).toBe("session=smoke-cookie");
      }
      if (headers.has("x-smoke-secret")) {
        expect(url.pathname).toBe("/smoke/session");
      }
    }
    const again = createTransport();
    expect(
      summarize(await runRefreshJourney(OPTIONS, again.fetcher)).failed,
    ).toBe(0);
    expect(
      again.requests.find(({ step }) => step === "refresh 1")?.body,
    ).toContain("refresh_token=refresh-0");
  });

  test.each(
    STEPS.flatMap((step) =>
      (["http", "transport", "malformed"] as const).map(
        (kind) => ({ step, kind }) as const,
      ),
    ),
  )(
    "fails the run at $step for $kind and cleans up issued tokens",
    async (failure) => {
      const { fetcher, requests } = createTransport({ failure });
      const results = await runRefreshJourney(OPTIONS, fetcher);
      expect(
        results
          .filter(({ status }) => status === "failed")
          .map(({ name }) => name),
      ).toEqual([`OAuth refresh: ${failure.step}`]);
      expect(summarize(results).failed).toBe(1);
      const refreshRequests = requests.filter(({ step }) =>
        step.startsWith("refresh "),
      );
      if (failure.step.startsWith("refresh ")) {
        expect(refreshRequests.at(-1)?.step).toBe(failure.step);
      }
      const issued =
        requests.some(({ step }) => step === "token") &&
        failure.step !== "token";
      expect(requests.some(({ step }) => step === "revoke")).toBe(issued);
      for (const value of [
        "smoke-fixture-secret",
        "smoke-cookie",
        "fixture-code",
        "access-0",
        "refresh-0",
      ]) {
        expect(JSON.stringify(results)).not.toContain(value);
      }
    },
  );

  test.each([1, 2, 3])(
    "fails if refresh %s returns the previous refresh token",
    async (repeatRefresh) => {
      const { fetcher, requests } = createTransport({ repeatRefresh });
      const results = await runRefreshJourney(OPTIONS, fetcher);
      expect(results.filter(({ status }) => status === "failed")).toMatchObject(
        [{ name: `OAuth refresh: refresh ${String(repeatRefresh)}` }],
      );
      expect(
        requests.some(
          ({ step }) =>
            step === `successor ${String(repeatRefresh)} initialize`,
        ),
      ).toBe(false);
      expect(requests.at(-1)?.step).toBe("revoke");
    },
  );

  test.each(["http", "transport"] as const)(
    "warns without failing when revocation has a %s failure",
    async (kind) => {
      const { fetcher } = createTransport({
        failure: { step: "revoke", kind },
      });
      const results = await runRefreshJourney(OPTIONS, fetcher);
      expect(results.at(-1)).toMatchObject({
        name: "OAuth refresh: revoke",
        status: "warned",
      });
      expect(summarize(results)).toEqual({ failed: 0, skipped: 0 });
    },
  );

  test("signs in once in production, rotates twice with identical replay pairs and revokes the grant", async () => {
    const { fetcher, requests } = createTransport();
    const results = await runRefreshJourney(PRODUCTION_OPTIONS, fetcher);
    expect(summarize(results)).toEqual({ failed: 0, skipped: 0 });
    expect(results.map(({ name }) => name)).toEqual(
      [
        "sign-in",
        "session",
        "discovery",
        "authorize",
        "consent",
        "callback",
        "token",
        ...[1, 2].flatMap((round) => [
          `refresh ${String(round)}`,
          `refresh ${String(round)} replay`,
          `successor ${String(round)} initialize`,
          `successor ${String(round)} read`,
        ]),
        "revoke",
      ].map((step) => `OAuth refresh: ${step}`),
    );
    expect(requests.filter(({ step }) => step === "sign-in")).toHaveLength(1);
    expect(requests.some(({ step }) => step === "bootstrap")).toBe(false);
    const authorize = requests.find(({ step }) => step === "authorize");
    expect(authorize?.url.searchParams.get("resource")).toBe(`${BASE_URL}/mcp`);
    expect(authorize?.url.searchParams.get("scope")?.split(" ")).toContain(
      "offline_access",
    );
    for (const { step, url, headers, body } of requests) {
      expect([BASE_URL, FRONTEND_URL]).toContain(url.origin);
      if (url.pathname.startsWith("/api/auth/") && step !== "sign-in") {
        expect(headers.get("cookie")).toBe("session=restricted-cookie");
      }
      if (url.pathname === "/api/auth/oauth2/token") {
        expect(headers.get("content-type")).toBe(
          "application/x-www-form-urlencoded",
        );
        expect(new URLSearchParams(body).get("resource")).toBe(
          `${BASE_URL}/mcp`,
        );
      }
      expect(headers.has("x-smoke-secret")).toBe(false);
    }
    expect(new URLSearchParams(requests.at(-1)?.body).get("token")).toBe(
      "refresh-2",
    );
    expect(JSON.stringify(results)).not.toContain(PRODUCTION_OPTIONS.password);
  });

  test.each([undefined, "http", "transport", "malformed"] as const)(
    "stops production sign-in without retry on %s failure",
    async (kind) => {
      const { fetcher, requests } = createTransport(
        kind
          ? { failure: { step: "sign-in", kind } }
          : {
              responseBody: {
                step: "sign-in",
                body: { user: { email: "different@example.test" } },
              },
            },
      );
      const results = await runRefreshJourney(PRODUCTION_OPTIONS, fetcher);
      expect(results.filter(({ status }) => status === "failed")).toMatchObject(
        [{ name: "OAuth refresh: sign-in" }],
      );
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(results)).not.toContain(
        PRODUCTION_OPTIONS.password,
      );
    },
  );

  test.each([
    null,
    "https://api.example/api/auth/",
    "https://other.example/api/auth",
  ])(
    "rejects callback issuer %s before exchanging the code",
    async (callbackIssuer) => {
      const { fetcher, requests } = createTransport({ callbackIssuer });
      const results = await runRefreshJourney(PRODUCTION_OPTIONS, fetcher);
      expect(results.filter(({ status }) => status === "failed")).toMatchObject(
        [{ name: "OAuth refresh: callback" }],
      );
      expect(requests.some(({ step }) => step === "token")).toBe(false);
    },
  );

  test.each([
    "https://api.example/api/auth/",
    "https://other.example/api/auth",
  ])(
    "rejects metadata issuer %s differing from resource discovery",
    async (metadataIssuer) => {
      const { fetcher, requests } = createTransport({ metadataIssuer });
      const results = await runRefreshJourney(PRODUCTION_OPTIONS, fetcher);
      expect(results.filter(({ status }) => status === "failed")).toMatchObject(
        [{ name: "OAuth refresh: discovery" }],
      );
      expect(requests.some(({ step }) => step === "authorize")).toBe(false);
    },
  );

  test.each([
    { access_token: "access-1", refresh_token: "different-refresh" },
    { access_token: "different-access", refresh_token: "refresh-1" },
    { access_token: "access-1" },
    { error: "invalid_grant" },
  ])("requires the identical replay pair: %j", async (body) => {
    const { fetcher, requests } = createTransport({
      responseBody: { step: "refresh 1 replay", body },
    });
    const results = await runRefreshJourney(PRODUCTION_OPTIONS, fetcher);
    expect(results.filter(({ status }) => status === "failed")).toMatchObject([
      { name: "OAuth refresh: refresh 1 replay" },
    ]);
    expect(requests.at(-1)?.step).toBe("revoke");
  });

  test.each([{ email: undefined }, { password: undefined }])(
    "fails production with unavailable credentials on the configured target: %j",
    async (options) => {
      const fetcher: CanaryFetcher = async () => {
        throw new TypeError("must not fetch");
      };
      expect(
        summarize(
          await runRefreshJourney(
            { ...PRODUCTION_OPTIONS, ...options },
            fetcher,
          ),
        ),
      ).toEqual({ failed: 1, skipped: 0 });
    },
  );

  test.each([
    { email: undefined, password: undefined },
    { email: PRODUCTION_OPTIONS.email, password: PRODUCTION_OPTIONS.password },
  ])(
    "skips alternate production targets with an explicit reason: %j",
    async (credentials) => {
      const fetcher: CanaryFetcher = async () => {
        throw new TypeError("must not fetch");
      };
      const results = await runRefreshJourney(
        {
          ...PRODUCTION_OPTIONS,
          ...credentials,
          baseUrl: "https://alternate.example",
        },
        fetcher,
      );
      expect(results).toEqual([
        {
          name: "OAuth refresh: sign-in",
          status: "skipped",
          detail:
            "credential withheld: target is not the configured production endpoint",
        },
      ]);
      expect(summarize(results)).toEqual({ failed: 0, skipped: 1 });
    },
  );

  test("omits the production refresh journey in frequent mode", async () => {
    const fetcher: CanaryFetcher = async () => {
      throw new TypeError("must not fetch");
    };
    expect(
      await runRefreshJourney(
        { ...PRODUCTION_OPTIONS, mode: "frequent" },
        fetcher,
      ),
    ).toEqual([]);
  });

  test("fails staging bootstrap when its session credential is absent", async () => {
    const fetcher: CanaryFetcher = async () => {
      throw new TypeError("must not fetch");
    };
    expect(
      summarize(
        await runRefreshJourney(
          { ...OPTIONS, smokeSecret: undefined },
          fetcher,
        ),
      ).failed,
    ).toBe(1);
  });
});
