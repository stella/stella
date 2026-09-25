import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// This suite pins the OAuth/token-refresh connection lifecycle in
// `connections.ts` against faked crypto, OAuth, transport, and DB
// collaborators. All external collaborators are injected either as
// arguments (`safeDb`), or routed into an in-memory recorder (analytics), so
// no network, KMS, or Postgres access happens. The point is to lock in the
// exact failure-normalization contract the MCP gateway depends on.

type RefreshResult = Result<
  { access_token: string; refresh_token?: string },
  Error
>;

type CapturedTransport = {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  url: string;
};

// Mutable controls the mocked collaborators close over. Reset per test.
const state = {
  closes: 0,
  dbSets: [] as Record<string, unknown>[],
  encryptCalls: 0,
  refresh: (() =>
    Result.ok({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
    })) as () => RefreshResult,
  refreshCalls: 0,
  toolsOptions: [] as unknown[],
  toolsImpl: (async () => [
    { execute: async () => ({ content: [{ text: "ok", type: "text" }] }) },
  ]) as (defs?: unknown, options?: unknown) => Promise<unknown[]>,
  transports: [] as CapturedTransport[],
};

const connectionDependenciesTestDouble = {
  createMCPClient: async ({ transport }: { transport: CapturedTransport }) => {
    state.transports.push(transport);
    return {
      close: async () => {
        state.closes += 1;
      },
      tools: async (defs?: unknown, options?: unknown) => {
        state.toolsOptions.push(options);
        return await state.toolsImpl(defs, options);
      },
    };
  },
  refreshOAuthToken: async () => {
    state.refreshCalls += 1;
    return state.refresh();
  },
  tokenExpiresAt: () => new Date(Date.now() + 3_600_000),
  decryptMcpSecret: async ({ purpose }: { purpose: string }) =>
    `decrypted-${purpose}`,
  encryptMcpSecret: async () => {
    state.encryptCalls += 1;
    return { ciphertext: Buffer.from("cipher"), iv: Buffer.from("iv") };
  },
};

const {
  createMcpClientForConnection: createMcpClientForConnectionImpl,
  loadActiveMcpConnectionsForUser,
  proxyMcpToolCall: proxyMcpToolCallImpl,
} = await import("@/api/lib/mcp-upstream/connections");

const connectionDependencies = asTestRaw<
  NonNullable<
    Parameters<typeof createMcpClientForConnectionImpl>[0]["dependencies"]
  >
>(connectionDependenciesTestDouble);
const outboundFetch = asTestRaw<
  NonNullable<
    Parameters<typeof createMcpClientForConnectionImpl>[0]["outboundFetch"]
  >
>({
  safeOutboundFetchStream: async () =>
    Result.err(new Error("unused: transport is mocked at the client layer")),
  validateOutboundFetchTarget: async (url: string) =>
    Result.ok({ url: new URL(url) }),
});

const createMcpClientForConnection = async (
  options: Parameters<typeof createMcpClientForConnectionImpl>[0],
) =>
  await createMcpClientForConnectionImpl({
    ...options,
    dependencies: connectionDependencies,
    outboundFetch,
  });

const proxyMcpToolCall = async (
  options: Parameters<typeof proxyMcpToolCallImpl>[0],
) =>
  await proxyMcpToolCallImpl({
    ...options,
    dependencies: connectionDependencies,
    outboundFetch,
  });

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");

const cachedTool = {
  exposedName: "mcp__registry__lookup",
  inputSchema: { properties: {}, type: "object" },
  rawName: "lookup",
} satisfies CachedMcpToolDefinition;

// Records every `.set(...)` payload written through the fake so tests can
// assert on the status transitions the module persists.
const makeSafeDb = (): SafeDb => {
  const chain: Record<string, (arg?: unknown) => unknown> = {
    set: (value?: unknown) => {
      state.dbSets.push(asTestRaw<Record<string, unknown>>(value));
      return chain;
    },
    update: () => chain,
    where: () => chain,
  };
  // SAFETY: test double; the module only ever calls update().set().where()
  // and awaits the returned Result, none of which touches a real Transaction.
  return asTestRaw<SafeDb>(async (fn: (tx: unknown) => unknown) => {
    await fn(chain);
    return Result.ok(undefined);
  });
};

const oauthRow = (
  overrides: Partial<Extract<LoadedMcpConnection, { type: "oauth2" }>> = {},
): LoadedMcpConnection => ({
  accessTokenEncrypted: Buffer.from("access"),
  accessTokenIv: Buffer.from("iv"),
  allowedTools: null,
  connectorId: toSafeId<"mcpConnector">("connector_1"),
  description: "Registry connector",
  displayName: "Registry",
  // Expired by default so the refresh path is exercised.
  expiresAt: new Date(Date.now() - 60_000),
  oauthAuthorizationServerUrl: "https://auth.example.com",
  oauthClientId: "client-1",
  oauthClientSecretEncrypted: Buffer.from("secret"),
  oauthClientSecretIv: Buffer.from("iv"),
  oauthResourceUrl: "https://mcp.example.com",
  refreshTokenEncrypted: Buffer.from("refresh"),
  refreshTokenIv: Buffer.from("iv"),
  slug: "registry",
  type: "oauth2",
  url: "https://mcp.example.com/rpc",
  userConnectionId: toSafeId<"mcpUserConnection">("conn_1"),
  ...overrides,
});

const lastAuthHeader = () =>
  state.transports.at(-1)?.headers?.["Authorization"];

const hasStatusSet = (status: string) =>
  state.dbSets.some((set) => set["status"] === status);

let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
  state.closes = 0;
  state.dbSets = [];
  state.encryptCalls = 0;
  state.refreshCalls = 0;
  state.toolsOptions = [];
  state.refresh = () =>
    Result.ok({ access_token: "fresh-access", refresh_token: "fresh-refresh" });
  state.toolsImpl = async () => [
    { execute: async () => ({ content: [{ text: "ok", type: "text" }] }) },
  ];
  state.transports = [];
});

afterEach(() => {
  analytics.restore();
});

describe("MCP upstream connection lifecycle", () => {
  test("valid, unexpired OAuth token is used directly without a refresh", async () => {
    const client = await createMcpClientForConnection({
      organizationId,
      row: oauthRow({ expiresAt: new Date(Date.now() + 3_600_000) }),
      safeDb: makeSafeDb(),
      userId,
    });

    expect(client).not.toBeNull();
    expect(state.refreshCalls).toBe(0);
    // Header carries the decrypted access token, not a refreshed one.
    expect(lastAuthHeader()).toBe("Bearer decrypted-mcp_access_token");
  });

  test("expired token triggers a refresh and the call proceeds with the new token", async () => {
    state.refresh = () =>
      Result.ok({ access_token: "rotated-token", refresh_token: "r2" });

    const client = await createMcpClientForConnection({
      organizationId,
      row: oauthRow(),
      safeDb: makeSafeDb(),
      userId,
    });

    expect(client).not.toBeNull();
    // Refresh is proactive (driven by `expiresAt`), not a 401-retry: the
    // token is resolved once, up front, before the client is opened.
    expect(state.refreshCalls).toBe(1);
    expect(lastAuthHeader()).toBe("Bearer rotated-token");
    // The rotated token is re-encrypted and persisted with status "connected".
    expect(state.encryptCalls).toBeGreaterThan(0);
    expect(hasStatusSet("connected")).toBe(true);
  });

  test("refresh failure normalizes to needs_reauth and a skipped (null) client", async () => {
    state.refresh = () => Result.err(new Error("token endpoint 400"));

    const client = await createMcpClientForConnection({
      organizationId,
      row: oauthRow(),
      safeDb: makeSafeDb(),
      userId,
    });

    expect(client).toBeNull();
    expect(hasStatusSet("needs_reauth")).toBe(true);
    // An upstream that revoked the grant is an expected state the module
    // normalizes, so nothing is reported as an exception.
    expect(analytics.exceptions()).toEqual([]);
  });

  test("refresh failure surfaces as an error tool-result, never a raw throw", async () => {
    state.refresh = () => Result.err(new Error("token endpoint 400"));

    const result = await proxyMcpToolCall({
      args: {},
      cachedTool,
      organizationId,
      row: oauthRow(),
      safeDb: makeSafeDb(),
      userId,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unavailable");
  });

  test("wraps MCP-shaped application output instead of trusting it as a result envelope", async () => {
    const applicationOutput = {
      content: [{ text: "nested output", type: "text" }],
      resultType: "input_required",
      structuredContent: { recordId: "record_1" },
    };
    state.toolsImpl = async () => [{ execute: async () => applicationOutput }];

    const result = await proxyMcpToolCall({
      args: {},
      cachedTool,
      organizationId,
      row: oauthRow(),
      safeDb: makeSafeDb(),
      userId,
    });

    expect(result).toEqual({
      content: [{ text: JSON.stringify(applicationOutput), type: "text" }],
    });
    expect(Object.keys(result)).toEqual(["content"]);
  });

  test("allows external tool execution to wait for a long-running upstream response", async () => {
    let observedTimeoutMs: number | undefined;
    const recordingOutboundFetch = asTestRaw<
      NonNullable<Parameters<typeof proxyMcpToolCallImpl>[0]["outboundFetch"]>
    >({
      safeOutboundFetchStream: async (
        args: Parameters<typeof outboundFetch.safeOutboundFetchStream>[0],
      ) => {
        observedTimeoutMs = args.timeoutMs;
        return Result.ok({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          headers: new Headers(),
          ok: true,
          status: 200,
        });
      },
      validateOutboundFetchTarget: async (url: string) =>
        Result.ok({ url: new URL(url) }),
    });
    state.toolsImpl = async () => [
      {
        execute: async () => {
          const transportFetch = state.transports.at(-1)?.fetch;
          if (!transportFetch) {
            throw new Error("MCP transport fetch was not configured");
          }
          await transportFetch("https://mcp.example.com/rpc", {
            body: JSON.stringify({
              id: 1,
              jsonrpc: "2.0",
              method: "tools/call",
              params: { arguments: {}, name: "lookup" },
            }),
            method: "POST",
          });
          return "ok";
        },
      },
    ];

    const result = await proxyMcpToolCallImpl({
      args: {},
      cachedTool,
      dependencies: connectionDependencies,
      organizationId,
      outboundFetch: recordingOutboundFetch,
      row: oauthRow({ expiresAt: new Date(Date.now() + 3_600_000) }),
      safeDb: makeSafeDb(),
      userId,
    });

    expect(result.isError).not.toBe(true);
    expect(observedTimeoutMs).toBe(5 * 60_000);
    expect(state.toolsOptions).toEqual([{ callToolTimeoutMs: 5 * 60_000 }]);
  });

  test("keeps initialization requests on the short discovery timeout", async () => {
    let observedTimeoutMs: number | undefined;
    const recordingOutboundFetch = asTestRaw<
      NonNullable<
        Parameters<typeof createMcpClientForConnectionImpl>[0]["outboundFetch"]
      >
    >({
      safeOutboundFetchStream: async (
        args: Parameters<typeof outboundFetch.safeOutboundFetchStream>[0],
      ) => {
        observedTimeoutMs = args.timeoutMs;
        return Result.ok({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          headers: new Headers(),
          ok: true,
          status: 200,
        });
      },
      validateOutboundFetchTarget: async (url: string) =>
        Result.ok({ url: new URL(url) }),
    });
    const initializingDependencies = asTestRaw<
      NonNullable<
        Parameters<typeof createMcpClientForConnectionImpl>[0]["dependencies"]
      >
    >({
      ...connectionDependenciesTestDouble,
      createMCPClient: async ({
        transport,
      }: {
        transport: CapturedTransport;
      }) => {
        await transport.fetch?.("https://mcp.example.com/rpc", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "initialize",
            params: {},
          }),
          method: "POST",
        });
        return connectionDependenciesTestDouble.createMCPClient({ transport });
      },
    });

    const client = await createMcpClientForConnectionImpl({
      dependencies: initializingDependencies,
      organizationId,
      outboundFetch: recordingOutboundFetch,
      row: oauthRow({ expiresAt: new Date(Date.now() + 3_600_000) }),
      safeDb: makeSafeDb(),
      userId,
    });

    expect(client).not.toBeNull();
    expect(observedTimeoutMs).toBe(10_000);
  });

  test("a missing refresh token short-circuits to needs_reauth without calling refresh", async () => {
    const client = await createMcpClientForConnection({
      organizationId,
      row: oauthRow({ refreshTokenEncrypted: null, refreshTokenIv: null }),
      safeDb: makeSafeDb(),
      userId,
    });

    expect(client).toBeNull();
    expect(state.refreshCalls).toBe(0);
    expect(hasStatusSet("needs_reauth")).toBe(true);
  });

  // FINDING (pinned, not fixed): a transport failure thrown from
  // `client.tools()` is NOT normalized inside `connections.ts`. There is no
  // catch around the tool call, so it rejects. Normalization to a structured
  // error happens one layer up, in the gateway caller
  // (`mcp/gateway/external-tools.ts` wraps `proxyMcpToolCall` in try/catch).
  test("an upstream failure during tools() propagates as a rejection (not normalized here)", async () => {
    state.toolsImpl = async () => {
      throw new Error("upstream timeout: the operation was aborted");
    };

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection = await proxyMcpToolCall({
      args: {},
      cachedTool,
      organizationId,
      row: oauthRow(),
      safeDb: makeSafeDb(),
      userId,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "upstream timeout",
    );
    // The `finally` still closes the client, so the connection does not leak.
    expect(state.closes).toBeGreaterThan(0);
  });

  test("an upstream failure during execute() propagates as a rejection (not normalized here)", async () => {
    state.toolsImpl = async () => [
      {
        execute: async () => {
          throw new Error("ECONNRESET from upstream");
        },
      },
    ];

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection = await proxyMcpToolCall({
      args: {},
      cachedTool,
      organizationId,
      row: oauthRow(),
      safeDb: makeSafeDb(),
      userId,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "ECONNRESET",
    );
    expect(state.closes).toBeGreaterThan(0);
  });

  // FINDING (pinned, not fixed): there is no single-flight guard. Each call
  // resolves its token independently, so N concurrent calls on an expired
  // OAuth connection stampede N refreshes and N DB writes.
  test("concurrent calls during an expired-token window each refresh independently", async () => {
    const safeDb = makeSafeDb();
    const row = oauthRow();

    await Promise.all([
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
    ]);

    expect(state.refreshCalls).toBe(3);
  });

  // FINDING (pinned, not fixed): the module keeps no in-memory circuit-breaker
  // or cooldown. Each failure writes needs_reauth again; there is no backoff
  // counter. The only "circuit break" is at the persistence layer
  // (`loadActiveMcpConnectionsForUser` filters status = "connected"), so a
  // downed connection is excluded on the *next load*, not by any in-module
  // state on a row that is already in hand.
  test("repeated refresh failures re-attempt every time (no in-module cooldown)", async () => {
    state.refresh = () => Result.err(new Error("token endpoint 400"));
    const safeDb = makeSafeDb();
    const row = oauthRow();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await createMcpClientForConnection({
        organizationId,
        row,
        safeDb,
        userId,
      });
    }

    expect(state.refreshCalls).toBe(3);
    expect(
      state.dbSets.filter((set) => set["status"] === "needs_reauth"),
    ).toHaveLength(3);
  });

  test("bearer connections send the decrypted static token, no OAuth path", async () => {
    const bearerRow: LoadedMcpConnection = {
      allowedTools: null,
      connectorId: toSafeId<"mcpConnector">("connector_1"),
      description: "Static-token connector",
      displayName: "Registry",
      slug: "registry",
      staticTokenEncrypted: Buffer.from("static"),
      staticTokenIv: Buffer.from("iv"),
      type: "bearer",
      url: "https://mcp.example.com/rpc",
      userConnectionId: toSafeId<"mcpUserConnection">("conn_1"),
    };

    const client = await createMcpClientForConnection({
      organizationId,
      row: bearerRow,
      safeDb: makeSafeDb(),
      userId,
    });

    expect(client).not.toBeNull();
    expect(state.refreshCalls).toBe(0);
    expect(lastAuthHeader()).toBe("Bearer decrypted-mcp_static_token");
  });
});

describe("loading a user's active MCP connections", () => {
  const storedRow = (overrides: Record<string, unknown>) => ({
    accessTokenEncrypted: Buffer.from("access"),
    accessTokenIv: Buffer.from("iv"),
    allowedTools: null,
    authType: "oauth2",
    connectorId: toSafeId<"mcpConnector">("connector_1"),
    description: "Registry connector",
    displayName: "Registry",
    expiresAt: null,
    oauthAuthorizationServerUrl: "https://auth.example.com",
    oauthClientId: "client-1",
    oauthClientSecretEncrypted: null,
    oauthClientSecretIv: null,
    oauthResourceUrl: "https://mcp.example.com",
    refreshTokenEncrypted: Buffer.from("refresh"),
    refreshTokenIv: Buffer.from("iv"),
    slug: "registry",
    staticTokenEncrypted: null,
    staticTokenIv: null,
    url: "https://mcp.example.com/rpc",
    userConnectionId: toSafeId<"mcpUserConnection">("conn_1"),
    ...overrides,
  });

  // The first call is the listing read, answered with `rows`; every later call
  // is a write, recorded through the update chain.
  const makeListingSafeDb = (rows: unknown[]) => {
    let calls = 0;
    let updates = 0;
    const chain: Record<string, (arg?: unknown) => unknown> = {
      set: (value?: unknown) => {
        state.dbSets.push(asTestRaw<Record<string, unknown>>(value));
        return chain;
      },
      update: () => {
        updates += 1;
        return chain;
      },
      where: () => chain,
    };
    // SAFETY: test double; the listing read never reaches the callback, and
    // the writes only call update().set().where().
    const safeDb = asTestRaw<SafeDb>(async (fn: (tx: unknown) => unknown) => {
      calls += 1;
      if (calls === 1) {
        return Result.ok(rows);
      }
      await fn(chain);
      return Result.ok(undefined);
    });
    return { safeDb, updates: () => updates };
  };

  test("keeps usable rows in order and marks every malformed OAuth row in one write", async () => {
    const listing = makeListingSafeDb([
      storedRow({ userConnectionId: "conn_1" }),
      storedRow({ userConnectionId: "conn_2", oauthClientId: null }),
      storedRow({
        authType: "none",
        slug: "open",
        userConnectionId: "conn_3",
      }),
      storedRow({
        authType: "bearer",
        slug: "bearer-without-token",
        userConnectionId: "conn_4",
      }),
      storedRow({ userConnectionId: "conn_5", accessTokenIv: null }),
    ]);

    const loaded = await loadActiveMcpConnectionsForUser({
      organizationId,
      safeDb: listing.safeDb,
      userId,
    });

    expect(loaded.map((row) => [row.userConnectionId, row.type])).toEqual([
      ["conn_1", "oauth2"],
      ["conn_3", "none"],
    ]);
    expect(listing.updates()).toBe(1);
    expect(hasStatusSet("needs_reauth")).toBe(true);
  });

  test("writes nothing when every row is usable", async () => {
    const listing = makeListingSafeDb([storedRow({})]);

    const loaded = await loadActiveMcpConnectionsForUser({
      organizationId,
      safeDb: listing.safeDb,
      userId,
    });

    expect(loaded).toHaveLength(1);
    expect(listing.updates()).toBe(0);
  });
});
