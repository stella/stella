import { createCimdClientDiscovery } from "@better-auth/cimd";
import type { ClientDiscovery } from "@better-auth/oauth-provider";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, test } from "bun:test";

import {
  CIMD_STALE_IF_ERROR_GRACE_SECONDS,
  type CimdMetadataValidationStore,
  withStaleIfError,
} from "@/api/lib/auth/cimd-stale-if-error";

const CLIENT_ID = "https://client.example.test/metadata.json";
const REDIRECT_URI = "https://client.example.test/callback";

const DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: "Client",
  redirect_uris: [REDIRECT_URI],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
  response_types: ["code"],
};

type Upstream =
  | { type: "document" }
  | { type: "status"; status: number }
  | { type: "unreachable" }
  | { type: "invalid" };

type HarnessOptions = {
  minimumFetchInterval: number | string;
  /** Wraps the CIMD discovery inside the stale-if-error wrapper. */
  wrapInner?: (discovery: ClientDiscovery) => ClientDiscovery;
};

type HarnessState = {
  upstream: Upstream;
  fetches: number;
  validations: number;
  ageSeconds: number | undefined;
};

const createHarness = ({ minimumFetchInterval, wrapInner }: HarnessOptions) => {
  const state: HarnessState = {
    upstream: { type: "document" },
    fetches: 0,
    validations: 0,
    ageSeconds: undefined,
  };
  const store: CimdMetadataValidationStore = {
    recordValidated: async () => {
      state.validations += 1;
      state.ageSeconds = 0;
      await Promise.resolve();
    },
    readValidationAgeSeconds: async () => {
      await Promise.resolve();
      return state.ageSeconds;
    },
  };
  const cimdDiscovery = createCimdClientDiscovery({
    fetchClientMetadataResource: async () => {
      state.fetches += 1;
      await Promise.resolve();
      switch (state.upstream.type) {
        case "document":
          // Uncacheable, so every resolution revalidates upstream.
          return Response.json(DOCUMENT, {
            headers: { "cache-control": "no-store" },
          });
        case "status":
          return new Response("unavailable", {
            status: state.upstream.status,
          });
        case "unreachable":
          throw new TypeError("fetch failed");
        case "invalid":
          return new Response("<html></html>", {
            headers: { "content-type": "text/html" },
          });
        default: {
          const exhaustive: never = state.upstream;
          return exhaustive;
        }
      }
    },
    metadataFetchPolicy: { minimumFetchInterval },
    onClientCreated: async ({ client }) => {
      await store.recordValidated(client.clientId);
    },
    onClientRefreshed: async ({ client }) => {
      await store.recordValidated(client.clientId);
    },
  });
  const discovery = withStaleIfError(
    wrapInner ? wrapInner(cimdDiscovery) : cimdDiscovery,
    store,
  );
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthClient: [],
    oauthClientResource: [],
    oauthResource: [],
  };
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(database),
    rateLimit: { enabled: false },
    plugins: [
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        disableJwtPlugin: true,
        resourceSeedMode: "none",
        scopes: ["read"],
        extensions: [{ clientDiscovery: discovery }],
      }),
    ],
  });
  const authorize = async (clientId = CLIENT_ID): Promise<Response> => {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "read",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "request-state",
    });
    return await auth.handler(
      new Request(
        `http://localhost:3001/api/auth/oauth2/authorize?${query.toString()}`,
      ),
    );
  };
  return { state, database, authorize };
};

const isAccepted = (response: Response): boolean =>
  response.status === 302 &&
  (response.headers.get("location") ?? "").includes("/sign-in");

describe("CIMD stale-if-error", () => {
  test.each([
    { type: "status", status: 404 },
    { type: "status", status: 503 },
    { type: "unreachable" },
    { type: "invalid" },
  ] satisfies Upstream[])(
    "keeps a registered client within the window when upstream answers %o",
    async (upstream) => {
      const { state, authorize } = createHarness({ minimumFetchInterval: 0 });
      expect(isAccepted(await authorize())).toBe(true);
      expect(state.validations).toBe(1);

      state.upstream = upstream;
      state.ageSeconds = CIMD_STALE_IF_ERROR_GRACE_SECONDS;
      const fetchesBefore = state.fetches;
      expect(isAccepted(await authorize())).toBe(true);
      expect(state.fetches).toBe(fetchesBefore + 1);
      expect(state.validations).toBe(1);

      state.ageSeconds = CIMD_STALE_IF_ERROR_GRACE_SECONDS + 1;
      const refused = await authorize();
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_client" });
    },
  );

  test("answers a fetch the discovery's own pacing refuses from the stored client", async () => {
    const { state, authorize } = createHarness({ minimumFetchInterval: "1h" });
    expect(isAccepted(await authorize())).toBe(true);

    state.upstream = { type: "status", status: 404 };
    expect(isAccepted(await authorize())).toBe(true);
    const fetchesAfterFailure = state.fetches;
    // Within the failed-fetch interval the discovery refuses without fetching.
    expect(isAccepted(await authorize())).toBe(true);
    expect(state.fetches).toBe(fetchesAfterFailure);

    state.ageSeconds = CIMD_STALE_IF_ERROR_GRACE_SECONDS + 1;
    expect((await authorize()).status).toBe(429);
  });

  test("resumes validating once the document is back", async () => {
    const { state, authorize } = createHarness({ minimumFetchInterval: 0 });
    expect(isAccepted(await authorize())).toBe(true);
    state.upstream = { type: "status", status: 404 };
    state.ageSeconds = 60;
    expect(isAccepted(await authorize())).toBe(true);

    state.upstream = { type: "document" };
    expect(isAccepted(await authorize())).toBe(true);
    expect(state.validations).toBe(2);
    expect(state.ageSeconds).toBe(0);
  });

  test("never creates a client from an unavailable document", async () => {
    const { state, database, authorize } = createHarness({
      minimumFetchInterval: 0,
    });
    state.upstream = { type: "status", status: 404 };
    state.ageSeconds = 0;
    const refused = await authorize();
    expect(refused.status).toBe(400);
    expect(database["oauthClient"]).toEqual([]);
    expect(state.validations).toBe(0);
  });

  test("passes through refusals that are not revalidation failures", async () => {
    const failure = new Error("database unavailable");
    let failing = false;
    const { state, authorize } = createHarness({
      minimumFetchInterval: 0,
      wrapInner: (discovery) => ({
        ...discovery,
        resolve: async (ctx, clientId, existing) => {
          if (failing) {
            throw failure;
          }
          return await discovery.resolve(ctx, clientId, existing);
        },
      }),
    });
    expect(isAccepted(await authorize())).toBe(true);
    failing = true;
    state.ageSeconds = 0;
    expect((await authorize()).status).toBe(500);
  });
});
