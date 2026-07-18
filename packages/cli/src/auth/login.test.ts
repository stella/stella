import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { readCredentialFile } from "./credential-store.js";

// `login()` is the orchestrator: it wires PKCE + discovery + registration +
// (loopback | manual) callback + token exchange + credential persistence. The
// pure pieces are covered by their own sibling tests; this file pins the
// *orchestration decisions* — which callback transport is chosen, that a state
// mismatch is rejected before any token is stored, that a token-exchange
// failure propagates, and that the persisted credential carries exactly what
// later commands need (scopes, org, refresh token).
//
// Two seams are mocked. The loopback listener is delegated to the real
// implementation or forced to `undefined` (headless) per test; the browser
// opener never spawns a real browser and instead drives the callback the way a
// real browser redirect would.

const realLoopback = await import("./loopback-listener.js");
// Capture the genuine function *value* before mocking: reading it back off the
// namespace inside the factory would resolve to the mock itself (infinite
// recursion), since `mock.module` rebinds the live namespace.
const realStartLoopbackListener = realLoopback.startLoopbackListener;

let loopbackMode: "real" | "headless" = "real";
mock.module("./loopback-listener.js", () => ({
  ...realLoopback,
  startLoopbackListener: async () =>
    loopbackMode === "headless" ? undefined : await realStartLoopbackListener(),
}));

// Module mocks live for the whole process; spread the real module so only the
// spawning function is replaced (keeps `browser-open.test.ts`'s coverage of
// `openCommandFor` intact) and never let this file actually launch a browser.
const realBrowser = await import("./browser-open.js");
let onBrowserOpen: (authorizeUrl: string) => void | Promise<void> = () => {};
mock.module("./browser-open.js", () => ({
  ...realBrowser,
  openInBrowser: async (url: string) => {
    await onBrowserOpen(url);
    return true;
  },
}));

const { login } = await import("./login.js");

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const makeJwt = (claims: Record<string, unknown>): string =>
  `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.sig`;

const jwtWithOrg = (orgId: string | undefined): string =>
  makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(orgId ? { org_id: orgId } : {}),
    scope: "openid stella:read offline_access",
    sub: "user-1",
  });

const DEFAULT_SUPPORTED = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "stella:read",
  "stella:search",
];

type ProviderOptions = {
  readonly scopesSupported?: readonly string[];
  readonly registrationResponse?: () => Response;
  readonly tokenResponse?: (body: URLSearchParams) => Response;
};

const okTokenResponse = (): Response =>
  new Response(
    JSON.stringify({
      access_token: jwtWithOrg("org-42"),
      expires_in: 900,
      refresh_token: "refresh-abc",
      scope: "openid stella:read offline_access",
      token_type: "Bearer",
    }),
    { headers: { "Content-Type": "application/json" }, status: 200 },
  );

/** In-process authorization server: discovery + registration + token, routed by path. */
const startProvider = (options: ProviderOptions = {}) => {
  const counts = { registration: 0, token: 0 };
  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: `${origin}/authorize`,
          issuer: origin,
          registration_endpoint: `${origin}/register`,
          scopes_supported: options.scopesSupported ?? DEFAULT_SUPPORTED,
          token_endpoint: `${origin}/token`,
        });
      }
      if (url.pathname === "/register") {
        counts.registration += 1;
        return (
          options.registrationResponse?.() ??
          Response.json({ client_id: "cli-client-1" })
        );
      }
      if (url.pathname === "/token") {
        counts.token += 1;
        const body = new URLSearchParams(await request.text());
        return options.tokenResponse?.(body) ?? okTokenResponse();
      }
      return new Response("not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return {
    close: () => {
      void server.stop(true);
    },
    counts,
    url: `http://127.0.0.1:${server.port}`,
  };
};

/** Drives the loopback redirect the way a browser would after consent. */
const driveCallback =
  (options: { code?: string; state?: string } = {}) =>
  async (authorizeUrl: string) => {
    const parsed = new URL(authorizeUrl);
    const redirectUri = parsed.searchParams.get("redirect_uri");
    if (!redirectUri) {
      return;
    }
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", options.code ?? "auth-code-1");
    callback.searchParams.set(
      "state",
      options.state ?? parsed.searchParams.get("state") ?? "",
    );
    await fetch(callback).catch(() => {});
  };

/** A minimal fake process: captures stdout, optionally pre-feeds a stdin line. */
const makeProcess = (stdinLine?: string) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.resume();
  if (stdinLine !== undefined) {
    stdin.write(stdinLine);
  }
  return { stdin, stdout } as unknown as NodeJS.Process;
};

const baseOptions = (configDir: string, serverFlag: string) => ({
  configDir,
  orgHint: undefined,
  registrationScopes: ["openid", "stella:read"] as const,
  requestedScopes: ["openid", "stella:read", "offline_access"] as const,
  requiredScopes: ["openid", "stella:read"] as const,
  serverFlag,
});

describe("login orchestration", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "stella-cli-login-"));
    loopbackMode = "real";
    onBrowserOpen = () => {};
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  // The loopback module mock delegates to the real listener when
  // `loopbackMode === "real"`; leave it there so other test files that use the
  // real listener are unaffected by this file's headless scenario.
  afterAll(() => {
    loopbackMode = "real";
    onBrowserOpen = () => {};
  });

  test("loopback happy path persists a credential with org, scopes, and refresh token", async () => {
    const provider = startProvider();
    onBrowserOpen = driveCallback();

    try {
      const result = await login(
        makeProcess(),
        baseOptions(configDir, provider.url),
      );

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.orgId).toBe("org-42");
        expect(result.value.hasRefreshToken).toBe(true);
        expect(result.value.serverUrl).toBe(provider.url);
        expect(result.value.grantedScopes).toContain("offline_access");
      }

      // What every later command reads back off disk.
      const persisted = await readCredentialFile(configDir);
      const credential = persisted.credentials.at(0);
      expect(credential?.orgId).toBe("org-42");
      expect(credential?.refreshToken).toBe("refresh-abc");
      expect(credential?.scope).toContain("stella:read");
      expect(credential?.clientId).toBe("cli-client-1");
      // The server's default org is set so `--org`-less commands resolve.
      expect(persisted.defaultOrgByServer[provider.url]).toBe("org-42");
    } finally {
      provider.close();
    }
  });

  test("falls back to manual paste when no loopback listener can bind (headless)", async () => {
    loopbackMode = "headless";
    const provider = startProvider();

    try {
      // Headless: the browser opener cannot reach a local listener, so the user
      // pastes the code. A bare code (no state) is accepted.
      const result = await login(
        makeProcess("manual-code-xyz\n"),
        baseOptions(configDir, provider.url),
      );

      expect(Result.isOk(result)).toBe(true);
      const persisted = await readCredentialFile(configDir);
      expect(persisted.credentials.at(0)?.orgId).toBe("org-42");
      expect(provider.counts.token).toBe(1);
    } finally {
      provider.close();
    }
  });

  test("rejects a state mismatch before exchanging any token", async () => {
    const provider = startProvider();
    onBrowserOpen = driveCallback({ state: "attacker-supplied-state" });

    try {
      const result = await login(
        makeProcess(),
        baseOptions(configDir, provider.url),
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error._tag).toBe("LoopbackCallbackError");
      }
      // The forged callback must never reach the token endpoint...
      expect(provider.counts.token).toBe(0);
      // ...and no credential may be written.
      const persisted = await readCredentialFile(configDir);
      expect(persisted.credentials).toHaveLength(0);
    } finally {
      provider.close();
    }
  });

  test("propagates a token-exchange failure and writes no credential", async () => {
    const provider = startProvider({
      tokenResponse: () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          headers: { "Content-Type": "application/json" },
          status: 400,
        }),
    });
    onBrowserOpen = driveCallback();

    try {
      const result = await login(
        makeProcess(),
        baseOptions(configDir, provider.url),
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error._tag).toBe("TokenExchangeError");
      }
      const persisted = await readCredentialFile(configDir);
      expect(persisted.credentials).toHaveLength(0);
    } finally {
      provider.close();
    }
  });

  test("rejects a token whose access token carries no org_id claim", async () => {
    const provider = startProvider({
      tokenResponse: () =>
        new Response(
          JSON.stringify({
            access_token: jwtWithOrg(undefined),
            expires_in: 900,
            refresh_token: "refresh-abc",
            token_type: "Bearer",
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
    });
    onBrowserOpen = driveCallback();

    try {
      const result = await login(
        makeProcess(),
        baseOptions(configDir, provider.url),
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error._tag).toBe("MissingOrgClaimError");
      }
      const persisted = await readCredentialFile(configDir);
      expect(persisted.credentials).toHaveLength(0);
    } finally {
      provider.close();
    }
  });

  test("fails closed via scope negotiation when a required scope is unadvertised", async () => {
    // The server advertises scopes but not `stella:read`; negotiation must
    // abort before any client registration or token request happens.
    const provider = startProvider({
      scopesSupported: ["openid", "profile", "email"],
    });
    onBrowserOpen = driveCallback();

    try {
      const result = await login(
        makeProcess(),
        baseOptions(configDir, provider.url),
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error._tag).toBe("UnsupportedOAuthScopesError");
      }
      expect(provider.counts.registration).toBe(0);
      expect(provider.counts.token).toBe(0);
    } finally {
      provider.close();
    }
  });
});
