import { createCimdClientDiscovery } from "@better-auth/cimd";
import type { ClientDiscovery } from "@better-auth/oauth-provider";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CIMD_STALE_IF_ERROR_GRACE_MS,
  CLIENT_METADATA_VALIDATION_SCHEMA_PLUGIN,
  recordClientMetadataValidated,
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
};

const createHarness = ({ minimumFetchInterval, wrapInner }: HarnessOptions) => {
  const state: HarnessState = { upstream: { type: "document" }, fetches: 0 };
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
    onClientCreated: recordClientMetadataValidated,
    onClientRefreshed: recordClientMetadataValidated,
  });
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
      CLIENT_METADATA_VALIDATION_SCHEMA_PLUGIN,
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        disableJwtPlugin: true,
        resourceSeedMode: "none",
        scopes: ["read"],
        extensions: [
          {
            clientDiscovery: withStaleIfError(
              wrapInner ? wrapInner(cimdDiscovery) : cimdDiscovery,
            ),
          },
        ],
      }),
    ],
  });
  const authorize = async (): Promise<Response> => {
    const query = new URLSearchParams({
      client_id: CLIENT_ID,
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
  const clientRow = () => database["oauthClient"]?.at(0);
  const validatedAt = (): unknown => clientRow()?.["metadataValidatedAt"];
  /** Moves the recorded validation `ageMs` into the past. */
  const ageValidation = (ageMs: number) => {
    const row = clientRow();
    expect(row).toBeDefined();
    if (row) {
      row["metadataValidatedAt"] = new Date(Date.now() - ageMs);
    }
  };
  return { state, database, authorize, validatedAt, ageValidation };
};

const isAccepted = (response: Response): boolean =>
  response.status === 302 &&
  (response.headers.get("location") ?? "").includes("/sign-in");

// Leaves room for the request itself inside the window.
const WITHIN_WINDOW_MS = CIMD_STALE_IF_ERROR_GRACE_MS - 60_000;

describe("CIMD stale-if-error", () => {
  test.each([
    { type: "status", status: 404 },
    { type: "status", status: 503 },
    { type: "unreachable" },
    { type: "invalid" },
  ] satisfies Upstream[])(
    "keeps a registered client within the window when upstream answers %o",
    async (upstream) => {
      const harness = createHarness({ minimumFetchInterval: 0 });
      expect(isAccepted(await harness.authorize())).toBe(true);
      expect(harness.validatedAt()).toBeInstanceOf(Date);

      harness.state.upstream = upstream;
      harness.ageValidation(WITHIN_WINDOW_MS);
      const stamped = harness.validatedAt();
      const fetchesBefore = harness.state.fetches;
      expect(isAccepted(await harness.authorize())).toBe(true);
      expect(harness.state.fetches).toBe(fetchesBefore + 1);
      // A stale answer records no validation, so it cannot extend its window.
      expect(harness.validatedAt()).toBe(stamped);

      harness.ageValidation(CIMD_STALE_IF_ERROR_GRACE_MS + 1000);
      const refused = await harness.authorize();
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_client" });
    },
  );

  test("answers a fetch the discovery's own pacing refuses from the stored client", async () => {
    const harness = createHarness({ minimumFetchInterval: "1h" });
    expect(isAccepted(await harness.authorize())).toBe(true);

    harness.state.upstream = { type: "status", status: 404 };
    expect(isAccepted(await harness.authorize())).toBe(true);
    const fetchesAfterFailure = harness.state.fetches;
    // Within the failed-fetch interval the discovery refuses without fetching.
    expect(isAccepted(await harness.authorize())).toBe(true);
    expect(harness.state.fetches).toBe(fetchesAfterFailure);

    harness.ageValidation(CIMD_STALE_IF_ERROR_GRACE_MS + 1000);
    expect((await harness.authorize()).status).toBe(429);
  });

  test("records a new validation once the document is back", async () => {
    const harness = createHarness({ minimumFetchInterval: 0 });
    expect(isAccepted(await harness.authorize())).toBe(true);
    harness.state.upstream = { type: "status", status: 404 };
    harness.ageValidation(WITHIN_WINDOW_MS);
    expect(isAccepted(await harness.authorize())).toBe(true);

    harness.state.upstream = { type: "document" };
    const before = Date.now();
    expect(isAccepted(await harness.authorize())).toBe(true);
    const validatedAt = harness.validatedAt();
    expect(validatedAt).toBeInstanceOf(Date);
    if (validatedAt instanceof Date) {
      expect(validatedAt.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  test("never creates a client from an unavailable document", async () => {
    const harness = createHarness({ minimumFetchInterval: 0 });
    harness.state.upstream = { type: "status", status: 404 };
    const refused = await harness.authorize();
    expect(refused.status).toBe(400);
    expect(harness.database["oauthClient"]).toEqual([]);
  });

  test("answers from the registration a concurrent refresh stored, never the snapshot it replaced", async () => {
    let interleave = () => {};
    const harness = createHarness({
      minimumFetchInterval: 0,
      wrapInner: (discovery) => ({
        ...discovery,
        resolve: async (ctx, clientId, existing) => {
          const resolution = Result.tryPromise({
            try: async () => await discovery.resolve(ctx, clientId, existing),
            catch: (cause) => cause,
          });
          // Another instance's refresh commits while this refetch is failing.
          interleave();
          const resolved = await resolution;
          if (Result.isError(resolved)) {
            throw resolved.error;
          }
          return resolved.value;
        },
      }),
    });
    expect(isAccepted(await harness.authorize())).toBe(true);

    // This request's snapshot still lists the callback, and its validation
    // has expired; the refresh drops the callback and stamps a fresh time.
    harness.ageValidation(CIMD_STALE_IF_ERROR_GRACE_MS + 1000);
    harness.state.upstream = { type: "status", status: 404 };
    interleave = () => {
      const row = harness.database["oauthClient"]?.at(0);
      if (row) {
        row["redirectUris"] = ["https://client.example.test/other-callback"];
        row["metadataValidatedAt"] = new Date();
      }
    };
    const response = await harness.authorize();

    expect(isAccepted(response)).toBe(false);
    expect(response.headers.get("location")).toContain(
      "error=invalid_redirect",
    );
  });

  test("passes through refusals that are not revalidation failures", async () => {
    let failing = false;
    const harness = createHarness({
      minimumFetchInterval: 0,
      wrapInner: (discovery) => ({
        ...discovery,
        resolve: async (ctx, clientId, existing) => {
          if (failing) {
            throw new Error("database unavailable");
          }
          return await discovery.resolve(ctx, clientId, existing);
        },
      }),
    });
    expect(isAccepted(await harness.authorize())).toBe(true);
    failing = true;
    expect((await harness.authorize()).status).toBe(500);
  });
});
