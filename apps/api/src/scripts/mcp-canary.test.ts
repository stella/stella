import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_ACCOUNT_POLICY,
  DESKTOP_ACCOUNT_PROTOCOL_HEADER,
} from "@stll/api-contract/desktop-registry";
import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Base64Url as legacySha256Base64Url } from "@stll/sha256/node";

import { VerifiedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof";
import { bridgeOauthUiRedirect } from "@/api/lib/oauth-ui-fragment";
import { SAMPLE_MATTERS } from "@/api/lib/review-organization/sample-data";
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
  runReviewAccountJourney,
  runAuthenticatedStreamProbe,
  runNamedProbe,
  summarize,
} from "./mcp-canary";

const REVIEW_BASE_URL = "https://api.example";
const REVIEW_FRONTEND_URL = "https://app.example";
const REVIEW_EMAIL = "review@stll.app";
const REVIEW_PASSWORD = "review-password-secret";
const REVIEW_TASK_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_MATTER_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_EXISTING_TASK_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_REQUIRED_TOOLS = [
  "list_tasks",
  "save_task",
  "delete_task",
] as const;

type ReviewFailure = {
  step: string;
  kind: "transport" | "http" | "malformed";
};

type ReviewCallbackMutation =
  | "missing-state"
  | "wrong-state"
  | "wrong-origin"
  | "wrong-path";
type ReviewAttack = "maliciousDiscovery" | "maliciousConsent";

const REVIEW_ATTACKS: readonly ReviewAttack[] = [
  "maliciousDiscovery",
  "maliciousConsent",
];
const REVIEW_CALLBACK_MUTATIONS: readonly ReviewCallbackMutation[] = [
  "missing-state",
  "wrong-state",
  "wrong-origin",
  "wrong-path",
];

const observedRequest = (
  observed: { url: string; headers: Headers; body: string }[],
  pathnameSuffix: string,
) => {
  const request = observed.find(({ url }) =>
    new URL(url).pathname.endsWith(pathnameSuffix),
  );
  if (!request) {
    throw new Error(`fixture did not observe ${pathnameSuffix}`);
  }
  return request;
};

const REVIEW_FAILURE_CASES: readonly (readonly [
  string,
  ReviewFailure["kind"],
])[] = [
  ["sign-in", "transport"],
  ["sign-in", "http"],
  ["sign-in", "malformed"],
  ["session", "transport"],
  ["session", "http"],
  ["session", "malformed"],
  ["discovery", "transport"],
  ["discovery", "http"],
  ["discovery", "malformed"],
  ["authorize", "transport"],
  ["authorize", "http"],
  ["authorize", "malformed"],
  ["consent", "transport"],
  ["consent", "http"],
  ["consent", "malformed"],
  ["token", "transport"],
  ["token", "http"],
  ["token", "malformed"],
  ["initialize", "transport"],
  ["initialize", "http"],
  ["initialize", "malformed"],
  ["tools/list", "transport"],
  ["tools/list", "http"],
  ["tools/list", "malformed"],
  ["read", "transport"],
  ["read", "http"],
  ["read", "malformed"],
  ["write", "transport"],
  ["write", "http"],
  ["write", "malformed"],
  ["assert", "transport"],
  ["assert", "http"],
  ["assert", "malformed"],
  ["cleanup", "transport"],
  ["cleanup", "http"],
  ["cleanup", "malformed"],
];

const readFakeRequestBody = async (
  body: unknown,
  request: Request | undefined,
): Promise<string> => {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return request ? await request.clone().text() : "";
};

type ReviewCallbackUrlOptions = {
  callback: string | null | undefined;
  state: string | null | undefined;
  mutation: ReviewCallbackMutation | undefined;
  maliciousConsent: boolean | undefined;
};
const reviewCallbackUrl = ({
  callback,
  state,
  mutation,
  maliciousConsent,
}: ReviewCallbackUrlOptions) => {
  if (!callback || !state) {
    throw new TypeError("fixture missing callback or state");
  }
  const url = new URL(callback);
  url.searchParams.set("code", "secret-code");
  url.searchParams.set("state", state);
  switch (mutation) {
    case "missing-state":
      url.searchParams.delete("state");
      break;
    case "wrong-state":
      url.searchParams.set("state", "attacker-state");
      break;
    case "wrong-origin":
      url.hostname = "localhost";
      break;
    case "wrong-path":
      url.pathname = "/unexpected";
      break;
    case undefined:
      break;
  }
  if (maliciousConsent) {
    url.hostname = "foreign.example";
    url.protocol = "https:";
    url.port = "";
  }
  return url.toString();
};

const reviewFetcher = (
  options: {
    failure?: ReviewFailure;
    responseBody?: { step: string; body: unknown };
    maliciousDiscovery?: boolean;
    maliciousConsent?: boolean;
    foreignEndpoint?: "authorize" | "token";
    tokenOrigin?: "api" | "frontend";
    callbackMutation?: ReviewCallbackMutation;
    observed?: { url: string; headers: Headers; body: string }[];
  } = {},
): CanaryFetcher => {
  let writtenTaskName = "";
  const observed = options.observed ?? [];
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const headers = new Headers(init.headers ?? request?.headers);
    const body = await readFakeRequestBody(init.body, request);
    observed.push({ url: url.toString(), headers, body });
    let expectedOrigin = REVIEW_BASE_URL;
    if (url.pathname.startsWith("/api/auth/")) {
      expectedOrigin = REVIEW_FRONTEND_URL;
    }
    if (
      url.pathname === "/api/auth/oauth2/token" &&
      options.tokenOrigin === "api"
    ) {
      expectedOrigin = REVIEW_BASE_URL;
    }
    if (url.origin !== expectedOrigin) {
      return new Response(null, { status: 404 });
    }
    if (
      [
        "/api/auth/get-session",
        "/api/auth/oauth2/authorize",
        "/api/auth/oauth2/consent",
      ].includes(url.pathname) &&
      headers.get("cookie") !== "session=review-cookie"
    ) {
      return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    }
    let step: string;
    let response: Response;
    const json = (
      value: unknown,
      status = 200,
      responseHeaders?: RequestInit["headers"],
    ) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          "content-type": "application/json",
          ...Object.fromEntries(new Headers(responseHeaders)),
        },
      });
    if (url.pathname === "/api/auth/sign-in/email") {
      step = "sign-in";
      response = json({ user: { email: REVIEW_EMAIL } }, 200, {
        "set-cookie": "session=review-cookie; Path=/; HttpOnly",
      });
    } else if (url.pathname === "/api/auth/get-session") {
      step = "session";
      response = json({
        user: { email: REVIEW_EMAIL },
        session: { activeOrganizationId: "org_review" },
      });
    } else if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      step = "discovery";
      response = json(
        {
          authorization_servers: [
            options.maliciousDiscovery
              ? "https://foreign.example/api/auth"
              : `${REVIEW_BASE_URL}/api/auth`,
          ],
          resource: `${REVIEW_BASE_URL}/mcp`,
        },
        200,
        { "set-cookie": "session=api-cookie; Path=/; HttpOnly" },
      );
    } else if (
      url.pathname === "/.well-known/oauth-authorization-server/api/auth"
    ) {
      step = "discovery";
      const authorizationOrigin =
        options.foreignEndpoint === "authorize"
          ? "https://foreign.example"
          : REVIEW_FRONTEND_URL;
      let tokenOrigin = REVIEW_FRONTEND_URL;
      if (options.tokenOrigin === "api") {
        tokenOrigin = REVIEW_BASE_URL;
      }
      if (options.foreignEndpoint === "token") {
        tokenOrigin = "https://foreign.example";
      }
      response = json({
        authorization_endpoint: `${authorizationOrigin}/api/auth/oauth2/authorize`,
        token_endpoint: `${tokenOrigin}/api/auth/oauth2/token`,
        registration_endpoint: `${REVIEW_BASE_URL}/api/auth/oauth2/register`,
        code_challenge_methods_supported: ["S256"],
      });
    } else if (url.pathname === "/api/auth/oauth2/authorize") {
      step = "authorize";
      response = json({
        url: `${REVIEW_FRONTEND_URL}/consent#oauth_query=signed-query`,
      });
    } else if (url.pathname === "/api/auth/oauth2/consent") {
      step = "consent";
      const authorize = observed.find(
        (item) => new URL(item.url).pathname === "/api/auth/oauth2/authorize",
      );
      const authorizeUrl = authorize ? new URL(authorize.url) : undefined;
      const callback = authorizeUrl?.searchParams.get("redirect_uri");
      const state = authorizeUrl?.searchParams.get("state");
      response = json({
        url: reviewCallbackUrl({
          callback,
          state,
          mutation: options.callbackMutation,
          maliciousConsent: options.maliciousConsent,
        }),
      });
    } else if (url.pathname === "/api/auth/oauth2/token") {
      step = "token";
      response = json({ access_token: "review-access-token" });
    } else if (url.pathname === "/mcp") {
      const requestBody = v.parse(
        v.object({
          method: v.string(),
          params: v.optional(
            v.object({
              name: v.optional(v.picklist(REVIEW_REQUIRED_TOOLS)),
              arguments: v.optional(
                v.object({
                  task_id: v.optional(v.string()),
                  name: v.optional(v.string()),
                }),
              ),
            }),
          ),
        }),
        JSON.parse(body),
      );
      if (requestBody.method === "initialize") {
        step = "initialize";
        response = json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "review-fixture" },
          },
        });
      } else if (requestBody.method === "tools/list") {
        step = "tools/list";
        response = json({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: REVIEW_REQUIRED_TOOLS.map((name) => ({
              name,
            })),
          },
        });
      } else {
        const name = requestBody.params?.name;
        let structuredContent: unknown;
        switch (name) {
          case "list_tasks": {
            const taskId = requestBody.params?.arguments?.task_id;
            step = taskId ? "assert" : "read";
            if (taskId) {
              structuredContent = { task: { taskId, name: writtenTaskName } };
              break;
            }
            structuredContent = {
              tasks: [
                {
                  id: REVIEW_EXISTING_TASK_ID,
                  name: SAMPLE_MATTERS.flatMap(({ tasks }) =>
                    tasks.map((task) => task.name),
                  ).at(0),
                  matterId: REVIEW_MATTER_ID,
                },
              ],
            };
            break;
          }
          case "save_task":
            step = "write";
            writtenTaskName = String(requestBody.params?.arguments?.name);
            structuredContent = { taskId: REVIEW_TASK_ID };
            break;
          case "delete_task":
            step = "cleanup";
            structuredContent = { deleted: true };
            break;
          case undefined:
            throw new TypeError("fixture received an unknown tool");
        }
        response = json({
          jsonrpc: "2.0",
          id: 3,
          result: { structuredContent },
        });
      }
    } else {
      step = "unknown";
      response = new Response(null, { status: 404 });
    }
    if (options.responseBody?.step === step) {
      response = json(options.responseBody.body);
    }
    if (options.failure?.step === step) {
      if (options.failure.kind === "transport") {
        throw new TypeError(`transport leaked ${REVIEW_PASSWORD}`);
      }
      if (options.failure.kind === "http") {
        response = json(
          { code: "INVALID_EMAIL_OR_PASSWORD", message: REVIEW_PASSWORD },
          503,
        );
      } else {
        response = json({ malformed: true });
      }
    }
    return response;
  };
};

describe("restricted review-account journey", () => {
  test.each(["frontend", "api"] as const)(
    "completes OAuth across configured origins with the token endpoint on %s",
    async (tokenOrigin) => {
      const observed: { url: string; headers: Headers; body: string }[] = [];
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher({ observed, tokenOrigin }),
      );

      expect(results.map(({ name, status }) => [name, status])).toEqual([
        ["restricted account: sign-in", "passed"],
        ["restricted account: session", "passed"],
        ["restricted account: discovery", "passed"],
        ["restricted account: authorize", "passed"],
        ["restricted account: consent", "passed"],
        ["restricted account: callback", "passed"],
        ["restricted account: token", "passed"],
        ["restricted account: initialize", "passed"],
        ["restricted account: tools/list", "passed"],
        ["restricted account: read", "passed"],
        ["restricted account: write", "passed"],
        ["restricted account: assert", "passed"],
        ["restricted account: cleanup", "passed"],
      ]);
      expect(
        JSON.parse(observedRequest(observed, "/sign-in/email").body),
      ).toEqual({
        email: REVIEW_EMAIL,
        password: REVIEW_PASSWORD,
      });
      expect(
        new URL(observedRequest(observed, "/sign-in/email").url).origin,
      ).toBe(REVIEW_FRONTEND_URL);
      expect(
        new URL(observedRequest(observed, "/get-session").url).origin,
      ).toBe(REVIEW_FRONTEND_URL);
      const metadata = observedRequest(
        observed,
        "/.well-known/oauth-authorization-server/api/auth",
      );
      expect(new URL(metadata.url).origin).toBe(REVIEW_BASE_URL);
      expect(metadata.headers.get("cookie")).toBe("session=api-cookie");
      for (const request of observed) {
        const origin = new URL(request.url).origin;
        expect([REVIEW_BASE_URL, REVIEW_FRONTEND_URL]).toContain(origin);
        if (request.headers.has("cookie")) {
          expect(request.headers.get("cookie")).toBe(
            origin === REVIEW_FRONTEND_URL
              ? "session=review-cookie"
              : "session=api-cookie",
          );
        }
        if (request.headers.has("authorization")) {
          expect(origin).toBe(REVIEW_BASE_URL);
        }
        if (request.body.includes(REVIEW_PASSWORD)) {
          expect(origin).toBe(REVIEW_FRONTEND_URL);
        }
      }
      const authorize = new URL(observedRequest(observed, "/authorize").url);
      expect(authorize.origin).toBe(REVIEW_FRONTEND_URL);
      expect(
        observedRequest(observed, "/authorize").headers.get("cookie"),
      ).toBe("session=review-cookie");
      expect(observedRequest(observed, "/consent").headers.get("cookie")).toBe(
        "session=review-cookie",
      );
      expect(authorize.searchParams.get("client_id")).toBe(
        `${REVIEW_BASE_URL}/v1/mcp/oauth/cli-client-metadata.json`,
      );
      const tokenRequest = observedRequest(observed, "/token");
      expect(new URL(tokenRequest.url).origin).toBe(
        tokenOrigin === "api" ? REVIEW_BASE_URL : REVIEW_FRONTEND_URL,
      );
      const verifier = new URLSearchParams(tokenRequest.body).get(
        "code_verifier",
      );
      if (!verifier) {
        throw new Error("token request did not include a PKCE verifier");
      }
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.get("code_challenge")).toBe(
        legacySha256Base64Url(verifier),
      );
      expect(authorize.searchParams.get("scope")).toContain(
        "stella:admin_write",
      );
      expect(
        observed
          .filter(({ headers }) => headers.has("authorization"))
          .every(({ url }) => new URL(url).origin === REVIEW_BASE_URL),
      ).toBe(true);
      expect(
        observed.some(({ headers }) =>
          headers.get("cookie")?.includes("review-cookie"),
        ),
      ).toBe(true);
      expect(
        observed
          .find(({ url }) => new URL(url).pathname === "/mcp")
          ?.headers.get("authorization"),
      ).toBe("Bearer review-access-token");
      expect(
        observed.some(
          ({ body }) =>
            body.includes("list_audit_log") || body.includes("save_time_entry"),
        ),
      ).toBe(false);
    },
  );

  test("skips when password is absent, target is unconfigured, or mode is frequent", async () => {
    const fetcher: CanaryFetcher = async () => {
      throw new Error("must not fetch");
    };
    expect(
      await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          mode: "full",
        },
        fetcher,
      ),
    ).toMatchObject([
      { status: "skipped", name: "restricted account: sign-in" },
    ]);
    expect(
      await runReviewAccountJourney(
        {
          baseUrl: "https://other.example",
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        fetcher,
      ),
    ).toMatchObject([
      { status: "skipped", name: "restricted account: sign-in" },
    ]);
    expect(
      await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          password: REVIEW_PASSWORD,
          mode: "frequent",
        },
        fetcher,
      ),
    ).toEqual([]);
  });

  test.each(REVIEW_FAILURE_CASES)(
    "reports %s %s failures without leaking credentials",
    async (step, kind) => {
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher({ failure: { step, kind } }),
      );
      const failures = results.filter(({ status }) => status === "failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.name).toBe(`restricted account: ${step}`);
      const expectedStatus = {
        http: "HTTP 503",
        malformed: "HTTP 200",
        transport: "HTTP unavailable",
      } as const satisfies Record<ReviewFailure["kind"], string>;
      expect(failures[0]?.detail).toContain(expectedStatus[kind]);
      expect(failures[0]?.detail).toContain("envelope code");
      for (const credential of [
        REVIEW_PASSWORD,
        "secret-code",
        "review-access-token",
        "review-cookie",
      ]) {
        expect(JSON.stringify(results)).not.toContain(credential);
      }
      expect(failures[0]?.detail).not.toContain(REVIEW_PASSWORD);
      expect(failures[0]?.detail).not.toContain("secret-code");
      expect(failures[0]?.detail).not.toContain("review-access-token");
      expect(failures[0]?.detail).not.toContain("review-cookie");
    },
  );

  test.each(["authorize", "token"] as const)(
    "refuses an advertised %s endpoint on a third origin",
    async (foreignEndpoint) => {
      const observed: { url: string; headers: Headers; body: string }[] = [];
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher({ observed, foreignEndpoint }),
      );
      expect(results.at(-1)).toMatchObject({
        name: `restricted account: ${foreignEndpoint}`,
        status: "failed",
      });
      expect(
        observed.every(({ url }) =>
          [REVIEW_BASE_URL, REVIEW_FRONTEND_URL].includes(new URL(url).origin),
        ),
      ).toBe(true);
      expect(results.some(({ status }) => status === "skipped")).toBe(false);
      for (const credential of [
        REVIEW_PASSWORD,
        "secret-code",
        "review-access-token",
        "review-cookie",
        "api-cookie",
      ]) {
        expect(JSON.stringify(results)).not.toContain(credential);
      }
    },
  );

  test.each(REVIEW_ATTACKS)(
    "contains %s redirects to the configured API and owned callback",
    async (attack) => {
      const observed: { url: string; headers: Headers; body: string }[] = [];
      const options =
        attack === "maliciousDiscovery"
          ? { maliciousDiscovery: true, observed }
          : { maliciousConsent: true, observed };
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher(options),
      );
      expect(results.at(-1)).toMatchObject({
        status: "failed",
        name: `restricted account: ${attack === "maliciousDiscovery" ? "discovery" : "callback"}`,
      });
      expect(
        observed.every(({ url }) =>
          [REVIEW_BASE_URL, REVIEW_FRONTEND_URL].includes(new URL(url).origin),
        ),
      ).toBe(true);
      expect(
        observed
          .filter(({ headers }) => headers.has("authorization"))
          .every(({ url }) => new URL(url).origin === REVIEW_BASE_URL),
      ).toBe(true);
    },
  );

  test.each(REVIEW_REQUIRED_TOOLS)(
    "fails tool discovery when required tool %s is absent",
    async (missingTool) => {
      const observed: { url: string; headers: Headers; body: string }[] = [];
      const tools = REVIEW_REQUIRED_TOOLS.filter(
        (name) => name !== missingTool,
      ).map((name) => ({ name }));
      expect(tools.some(({ name }) => name === missingTool)).toBe(false);
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher({
          observed,
          responseBody: {
            step: "tools/list",
            body: { jsonrpc: "2.0", result: { tools } },
          },
        }),
      );
      expect(results.filter(({ status }) => status === "failed")).toMatchObject(
        [
          {
            name: "restricted account: tools/list",
            status: "failed",
            detail: expect.stringContaining("expected read/write tools"),
          },
        ],
      );
      expect(
        observed.some(({ body }) => body.includes('"method":"tools/call"')),
      ).toBe(false);
    },
  );

  test.each(["passed", "transport", "http", "malformed"] as const)(
    "cleans up the created task after a read-back failure with %s cleanup",
    async (cleanupKind) => {
      const observed: { url: string; headers: Headers; body: string }[] = [];
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher({
          observed,
          responseBody: {
            step: "assert",
            body: {
              jsonrpc: "2.0",
              result: {
                structuredContent: {
                  task: {
                    taskId: REVIEW_TASK_ID,
                    name: "Unexpected task name",
                  },
                },
              },
            },
          },
          ...(cleanupKind === "passed"
            ? {}
            : { failure: { step: "cleanup", kind: cleanupKind } }),
        }),
      );
      expect(
        results.find(({ name }) => name === "restricted account: write"),
      ).toMatchObject({ status: "passed" });
      const cleanupRequests = observed.filter(({ body }) =>
        body.includes('"name":"delete_task"'),
      );
      expect(cleanupRequests).toHaveLength(1);
      expect(JSON.parse(cleanupRequests.at(0)?.body ?? "{}")).toMatchObject({
        method: "tools/call",
        params: {
          name: "delete_task",
          arguments: { task_id: REVIEW_TASK_ID, confirm: true },
        },
      });
      expect(
        results.find(({ name }) => name === "restricted account: assert"),
      ).toMatchObject({
        status: "failed",
        detail: expect.stringContaining("created task did not round-trip"),
      });
      expect(results.at(-1)).toMatchObject({
        name: "restricted account: cleanup",
        status: cleanupKind === "passed" ? "passed" : "failed",
      });
      expect(
        results
          .filter(({ status }) => status === "failed")
          .map(({ name }) => name),
      ).toEqual(
        cleanupKind === "passed"
          ? ["restricted account: assert"]
          : ["restricted account: assert", "restricted account: cleanup"],
      );
      for (const credential of [
        REVIEW_PASSWORD,
        "secret-code",
        "review-access-token",
        "review-cookie",
      ]) {
        expect(JSON.stringify(results)).not.toContain(credential);
      }
    },
  );

  test.each(["list_audit_log", "save_time_entry", "delete_time_entry"])(
    "fails when excluded tool %s is exposed despite requested scopes",
    async (name) => {
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher({
          responseBody: {
            step: "tools/list",
            body: {
              jsonrpc: "2.0",
              result: {
                tools: [...REVIEW_REQUIRED_TOOLS, name].map((tool) => ({
                  name: tool,
                })),
              },
            },
          },
        }),
      );
      expect(results.at(-1)).toMatchObject({
        name: "restricted account: tools/list",
        status: "failed",
      });
    },
  );

  test.each([
    {
      step: "token",
      body: { error: "invalid_grant", error_description: REVIEW_PASSWORD },
      code: "invalid_grant",
    },
    {
      step: "initialize",
      body: {
        jsonrpc: "2.0",
        error: { code: -32_603, message: REVIEW_PASSWORD },
      },
      code: "-32603",
    },
    {
      step: "read",
      body: {
        jsonrpc: "2.0",
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: { code: "permission_denied", message: REVIEW_PASSWORD },
              }),
            },
          ],
        },
      },
      code: "permission_denied",
    },
    {
      step: "read",
      body: {
        jsonrpc: "2.0",
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: { code: REVIEW_PASSWORD } }),
            },
          ],
        },
      },
      code: "unrecognized",
    },
    {
      step: "read",
      body: { jsonrpc: "2.0", result: { structuredContent: { tasks: [] } } },
      code: "none",
    },
  ])(
    "reports safe envelope diagnostics at $step ($code)",
    async ({ step, body, code }) => {
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher({ responseBody: { step, body } }),
      );
      expect(results.at(-1)).toMatchObject({
        name: `restricted account: ${step}`,
        status: "failed",
      });
      expect(results.at(-1)?.detail).toContain(
        `HTTP 200; envelope code ${code}`,
      );
      expect(JSON.stringify(results)).not.toContain(REVIEW_PASSWORD);
    },
  );

  test.each(REVIEW_CALLBACK_MUTATIONS)(
    "rejects callback delivery with %s",
    async (callbackMutation) => {
      const results = await runReviewAccountJourney(
        {
          baseUrl: REVIEW_BASE_URL,
          configuredBaseUrl: REVIEW_BASE_URL,
          frontendUrl: REVIEW_FRONTEND_URL,
          password: REVIEW_PASSWORD,
          mode: "full",
        },
        reviewFetcher({ callbackMutation }),
      );
      expect(results.at(-1)).toMatchObject({
        status: "failed",
        name: "restricted account: callback",
      });
      // A receiver rejection or fetch failure reports a different cause: this
      // assertion pins rejection at the validation boundary, before delivery.
      expect(results.at(-1)?.detail).toContain(
        "expected the owned loopback callback and matching state",
      );
      expect(JSON.stringify(results)).not.toContain(REVIEW_PASSWORD);
    },
  );
});

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
      requestPath = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
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

  test("names the cause of a failed tool call in one bounded line", () => {
    const detail = (status: number, body: unknown) =>
      evaluateToolCall({ status, body }).detail;
    expect(detail(502, null)).toContain("(HTTP 502)");
    expect(
      detail(200, {
        jsonrpc: "2.0",
        error: { code: -32_602, message: "Invalid params" },
      }),
    ).toContain("(JSON-RPC error -32602 Invalid params)");
    expect(
      detail(200, {
        jsonrpc: "2.0",
        result: {
          isError: true,
          content: [{ type: "text", text: "Search is\nunavailable" }],
        },
      }),
    ).toContain("(tool error: Search is unavailable)");
    expect(detail(200, { jsonrpc: "2.0", result: { content: [] } })).toContain(
      "(result without content)",
    );
    expect(detail(200, "not json-rpc")).toContain("(no JSON-RPC result)");
    const long = detail(200, {
      jsonrpc: "2.0",
      result: {
        isError: true,
        content: [{ type: "text", text: "x".repeat(500) }],
      },
    });
    expect(long.length).toBeLessThan(300);
    expect(long).toContain("...");
  });
});

describe("OAuth client journeys", () => {
  const fakeOAuth = () => {
    const requests: { url: URL; init: Parameters<CanaryFetcher>[1] }[] = [];
    const fetcher: CanaryFetcher = async (input, init) => {
      const requestUrl = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
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
    const requests: {
      path: string;
      method: string;
      headers: Headers;
      body: string;
    }[] = [];
    let redeemCount = 0;
    const fetcher: CanaryFetcher = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const headers = new Headers(init.headers);
      const body = await new Response(init.body).text();
      requests.push({
        path: url.pathname,
        method: init.method ?? "GET",
        headers,
        body,
      });
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
    const redeems = requests.filter(({ path }) =>
      path.endsWith("/redeem-link"),
    );
    expect(redeems).toHaveLength(2);
    for (const { headers } of redeems) {
      expect(headers.get(DESKTOP_ACCOUNT_PROTOCOL_HEADER)).toBe(
        String(DESKTOP_ACCOUNT_POLICY.linkProtocol),
      );
    }
    expect(requests[4]?.headers.get("authorization")).toBe(
      "Bearer new-desktop-key",
    );
    expect(JSON.parse(requests[5]?.body ?? "{}")).toEqual({ type: "revoke" });
    const grants = requests
      .filter(({ path }) => path.endsWith("/grant"))
      .map(({ body }) =>
        v.parse(
          v.object({ correlationId: v.string(), deviceJkt: v.string() }),
          JSON.parse(body),
        ),
      );
    expect(grants).toHaveLength(2);
    expect(new Set(grants.map(({ deviceJkt }) => deviceJkt)).size).toBe(1);
    const proofIds = new Set<string>();
    for (const { path, method, headers, body } of redeems) {
      const payload = v.parse(
        v.object({ correlationId: v.string(), deviceJkt: v.string() }),
        JSON.parse(body),
      );
      const grant = grants.find(
        ({ correlationId }) => correlationId === payload.correlationId,
      );
      if (!grant) {
        throw new TypeError("Canary redemption must have a matching grant");
      }
      expect(payload.deviceJkt).toBe(grant.deviceJkt);
      const credential = headers.get("authorization");
      const verified = await VerifiedDesktopDeviceProof.verify({
        request: new Request(new URL(path, REVIEW_BASE_URL).toString(), {
          method,
          headers,
        }),
        expectedUrl: new URL(path, REVIEW_BASE_URL).toString(),
        expectedThumbprint: grant.deviceJkt,
        binding: credential
          ? {
              type: "account",
              keyId: "canary-desktop-key",
              credential: "new-desktop-key",
            }
          : { type: "link", nonce: payload.correlationId },
      });
      expect(verified.isOk()).toBe(true);
      if (verified.isErr()) {
        throw new TypeError("Canary redemption device proof must verify");
      }
      expect(verified.value.nonce).toBe(payload.correlationId);
      expect(verified.value.binding.type).toBe(credential ? "account" : "link");
      proofIds.add(verified.value.jti);
    }
    const cleanup = requests.at(-1);
    const grant = grants.at(0);
    if (!cleanup || !grant) {
      throw new TypeError("Canary cleanup must follow a desktop grant");
    }
    const cleanupProof = await VerifiedDesktopDeviceProof.verify({
      request: new Request(new URL(cleanup.path, REVIEW_BASE_URL).toString(), {
        method: cleanup.method,
        headers: cleanup.headers,
      }),
      expectedUrl: new URL(cleanup.path, REVIEW_BASE_URL).toString(),
      expectedThumbprint: grant.deviceJkt,
      binding: {
        type: "account",
        keyId: "canary-desktop-key",
        credential: "new-desktop-key",
      },
    });
    expect(cleanupProof.isOk()).toBe(true);
    if (cleanupProof.isErr()) {
      throw new TypeError("Canary cleanup device proof must verify");
    }
    expect(cleanupProof.value.binding.type).toBe("account");
    expect(cleanupProof.value.nonce).toBeUndefined();
    proofIds.add(cleanupProof.value.jti);
    expect(proofIds.size).toBe(3);
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
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
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
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
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
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
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
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
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
        new URL(input instanceof Request ? input.url : input.toString()).origin,
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
