import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { mcpUserConnections } from "@/api/db/schema";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import type { discoverOAuthMetadataForApproval } from "@/api/lib/mcp-upstream/oauth";
import {
  bindDiscoveredMetadata,
  discoverOAuthMetadata,
  MCP_OAUTH_INVALID_GRANT_CODE,
  MCP_OAUTH_DISCOVERY_TIMEOUT_CODE,
} from "@/api/lib/mcp-upstream/oauth";
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
  now: new Date(),
  dbSets: [] as Record<string, unknown>[],
  reviews: [] as Record<string, unknown>[],
  decryptCalls: 0,
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
  now: () => state.now,
  discoverOAuthMetadataForApproval: async ({
    rawMcpUrl: connectorUrl,
  }: Parameters<typeof discoverOAuthMetadataForApproval>[0]) =>
    Result.ok({
      protectedResource: {
        resource: connectorUrl,
        authorization_servers: ["https://auth.example.com"],
      },
      authorizationServer: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
      },
    }),
  wait: async () => {},
  discoverOAuthMetadata: async ({
    rawMcpUrl: connectorUrl,
  }: Parameters<typeof discoverOAuthMetadata>[0]) =>
    bindDiscoveredMetadata({
      connectorUrl,
      protectedResource: {
        resource: connectorUrl,
        authorization_servers: ["https://auth.example.com"],
      },
      authorizationServer: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
      },
    }),
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
  decryptMcpSecret: async ({ purpose }: { purpose: string }) => {
    state.decryptCalls += 1;
    return `decrypted-${purpose}`;
  },
  encryptMcpSecret: async () => {
    state.encryptCalls += 1;
    return { ciphertext: Buffer.from("cipher"), iv: Buffer.from("iv") };
  },
};

const {
  createMcpClientForConnection: createMcpClientForConnectionImpl,
  loadActiveMcpConnectionsForUser,
  proxyMcpToolCall: proxyMcpToolCallImpl,
  MCP_REFRESH_BACKOFF_MS,
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
  options: Omit<
    Parameters<typeof createMcpClientForConnectionImpl>[0],
    "permit"
  >,
) =>
  await createMcpClientForConnectionImpl({
    ...options,
    permit: outboundPermit,
    dependencies: connectionDependencies,
    outboundFetch,
  });

const proxyMcpToolCall = async (
  options: Omit<Parameters<typeof proxyMcpToolCallImpl>[0], "permit">,
) =>
  await proxyMcpToolCallImpl({
    ...options,
    permit: outboundPermit,
    dependencies: connectionDependencies,
    outboundFetch,
  });

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");
const outboundPermit = grantThirdPartyOutboundPermit();

const cachedTool = {
  exposedName: "mcp__registry__lookup",
  inputSchema: { properties: {}, type: "object" },
  rawName: "lookup",
} satisfies CachedMcpToolDefinition;

// Records every `.set(...)` payload written through the fake so tests can
// assert on the status transitions the module persists.
const makeSafeDb = () => {
  let lease: Date | null = null;
  let retryAfter: Date | null = null;
  let status = "connected";
  const persisted: Record<string, unknown> = {};
  const update = () => {
    let fields: Record<string, unknown> = {};
    const apply = () => {
      if (
        fields["refreshLeaseExpiresAt"] instanceof Date &&
        ((lease !== null && lease > state.now) ||
          (retryAfter !== null && retryAfter > state.now) ||
          status !== "connected")
      ) {
        return false;
      }
      state.dbSets.push(fields);
      Object.assign(persisted, fields);
      if (
        fields["refreshLeaseExpiresAt"] instanceof Date ||
        fields["refreshLeaseExpiresAt"] === null
      ) {
        lease = fields["refreshLeaseExpiresAt"];
      }
      if (
        fields["refreshRetryAfter"] instanceof Date ||
        fields["refreshRetryAfter"] === null
      ) {
        retryAfter = fields["refreshRetryAfter"];
      }
      if (typeof fields["status"] === "string") {
        status = fields["status"];
      }
      return true;
    };
    const chain = {
      set: (value: Record<string, unknown>) => {
        fields = value;
        return chain;
      },
      where: () => {
        const accepted = apply();
        // Writes that skip `.returning()` await this object and ignore it.
        return {
          returning: async () =>
            accepted ? [{ id: "conn_1", expiresAt: lease }] : [],
        };
      },
    };
    return chain;
  };
  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    leftJoin: () => selectChain,
    where: () => selectChain,
    limit: async () => {
      if (status !== "connected") {
        return [];
      }
      const row = oauthRow();
      return [
        {
          ...row,
          authType: row.type,
          oauthConnectorIssuer: "https://auth.example.com",
          oauthConnectorConfirmedEndpointOrigins: null,
          oauthReviewApprovedIssuer: null,
          oauthReviewApprovedEndpointOrigins: null,
          ...persisted,
        },
      ];
    },
  };
  const tx = {
    select: () => selectChain,
    update,
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          if (table !== mcpUserConnections) {
            state.reviews.push(values);
          }
          if (
            table === mcpUserConnections &&
            typeof values["status"] === "string"
          ) {
            status = values["status"];
            state.dbSets.push(values);
          }
        },
      }),
    }),
  };
  return asTestRaw<SafeDb>(async (operation: (tx: unknown) => unknown) =>
    Result.ok(await operation(tx)),
  );
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
  oauthIssuerBinding: {
    type: "approved",
    issuer: "https://auth.example.com",
    endpointOrigins: [],
  },
  oauthClientId: "client-1",
  oauthClientSecretEncrypted: Buffer.from("secret"),
  oauthClientSecretIv: Buffer.from("iv"),
  oauthResourceUrl: "https://mcp.example.com/rpc",
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
  state.now = new Date();
  state.closes = 0;
  state.dbSets = [];
  state.reviews = [];
  state.encryptCalls = 0;
  state.decryptCalls = 0;
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

test("uses only credentials configured for the connector", async () => {
  for (const expiresAt of [null, new Date(0)]) {
    for (const oauthResourceUrl of [
      "https://other.example.com/rpc",
      "https://mcp.example.com/other",
      "https://mcp.example.com/rp",
    ]) {
      const client = await createMcpClientForConnection({
        organizationId,
        userId,
        safeDb: makeSafeDb(),
        row: oauthRow({
          oauthResourceUrl,
          expiresAt,
        }),
      });
      expect(client).toBeNull();
    }
  }
  expect(state.transports).toEqual([]);
  expect(state.decryptCalls).toBe(0);
  expect(state.refreshCalls).toBe(0);
  expect(hasStatusSet("needs_approval")).toBe(true);
});

test("uses credentials for configured resource paths", async () => {
  for (const oauthResourceUrl of [
    "https://mcp.example.com",
    "https://mcp.example.com/rpc",
  ]) {
    const client = await createMcpClientForConnection({
      organizationId,
      userId,
      safeDb: makeSafeDb(),
      row: oauthRow({
        oauthResourceUrl,
        url: "https://mcp.example.com/rpc/v1",
        expiresAt: null,
      }),
    });
    expect(client).not.toBeNull();
    expect(lastAuthHeader()).toBe("Bearer decrypted-mcp_access_token");
  }
});

test("uses a consistent connection snapshot while preparing credentials", async () => {
  const row = oauthRow({ expiresAt: null });
  const client = await createMcpClientForConnectionImpl({
    permit: outboundPermit,
    organizationId,
    userId,
    safeDb: makeSafeDb(),
    outboundFetch,
    row,
    dependencies: asTestRaw<
      NonNullable<
        Parameters<typeof createMcpClientForConnectionImpl>[0]["dependencies"]
      >
    >({
      ...connectionDependenciesTestDouble,
      decryptMcpSecret: async () => {
        row.url = "https://mcp.example.com/updated";
        return "access";
      },
    }),
  });
  expect(client).not.toBeNull();
  expect(state.transports.at(0)?.url).toBe("https://mcp.example.com/rpc");
  expect(lastAuthHeader()).toBe("Bearer access");
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
    state.refresh = () =>
      Result.err(
        new HandlerError({
          status: 502,
          code: MCP_OAUTH_INVALID_GRANT_CODE,
          message: "Token refresh requires sign-in",
        }),
      );

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
    state.refresh = () =>
      Result.err(
        new HandlerError({
          status: 502,
          code: MCP_OAUTH_INVALID_GRANT_CODE,
          message: "Token refresh requires sign-in",
        }),
      );

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
      permit: outboundPermit,
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
      permit: outboundPermit,
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

  test("uses only the current configured authorization", async () => {
    for (const expiresAt of [
      new Date(state.now.getTime() - 1),
      new Date(state.now.getTime() + 120_000),
    ]) {
      const client = await createMcpClientForConnection({
        organizationId,
        row: oauthRow({
          oauthIssuerBinding: {
            type: "approved",
            issuer: "https://auth.example.com/current",
            endpointOrigins: [],
          },
          expiresAt,
        }),
        safeDb: makeSafeDb(),
        userId,
      });
      expect(client).toBeNull();
    }
    expect(state.decryptCalls).toBe(0);
    expect(state.refreshCalls).toBe(0);
    expect(hasStatusSet("needs_approval")).toBe(true);
    expect(state.reviews).toEqual([]);
  });

  test("requests review of a connector without a configured issuer", async () => {
    const client = await createMcpClientForConnection({
      organizationId,
      row: oauthRow({ oauthIssuerBinding: { type: "unconfigured" } }),
      safeDb: makeSafeDb(),
      userId,
    });
    expect(client).toBeNull();
    expect(state.decryptCalls).toBe(0);
    expect(state.refreshCalls).toBe(0);
    // The pending review blocks the connector; the connection keeps its
    // tokens for when an administrator approves.
    expect(state.dbSets).toEqual([]);
    expect(state.reviews).toEqual([
      expect.objectContaining({
        observedIssuer: "https://auth.example.com",
        observedEndpointOrigins: ["https://auth.example.com"],
      }),
    ]);
  });

  test("records no review when discovery for an unconfigured issuer fails", async () => {
    const client = await createMcpClientForConnectionImpl({
      organizationId,
      permit: outboundPermit,
      row: oauthRow({ oauthIssuerBinding: { type: "unconfigured" } }),
      safeDb: makeSafeDb(),
      userId,
      outboundFetch,
      dependencies: {
        ...connectionDependencies,
        discoverOAuthMetadataForApproval: async () =>
          Result.err(
            new HandlerError({
              status: 502,
              message: "MCP OAuth metadata discovery did not complete",
            }),
          ),
      },
    });
    expect(client).toBeNull();
    expect(state.decryptCalls).toBe(0);
    expect(state.dbSets).toEqual([]);
    expect(state.reviews).toEqual([]);
  });

  test("records authorization discovery that requires confirmation", async () => {
    const client = await createMcpClientForConnectionImpl({
      organizationId,
      permit: outboundPermit,
      row: oauthRow(),
      safeDb: makeSafeDb(),
      userId,
      outboundFetch,
      dependencies: {
        ...connectionDependencies,
        discoverOAuthMetadata: async () =>
          Result.err(
            new HandlerError({
              status: 409,
              code: "mcp_authorization_approval_required",
              message: "Authorization confirmation required",
            }),
          ),
      },
    });
    expect(client).toBeNull();
    expect(state.refreshCalls).toBe(0);
    expect(state.decryptCalls).toBe(0);
    expect(hasStatusSet("needs_approval")).toBe(true);
    expect(state.reviews).toEqual([
      expect.objectContaining({
        observedIssuer: "https://auth.example.com",
        observedEndpointOrigins: ["https://auth.example.com"],
      }),
    ]);
  });

  test("refresh discovery uses confirmed endpoint origins", async () => {
    const confirmedEndpointOrigins = ["https://auth.example.com"];
    let observedOrigins: readonly string[] | undefined;
    expect(
      await createMcpClientForConnectionImpl({
        organizationId,
        permit: outboundPermit,
        row: oauthRow({
          oauthIssuerBinding: {
            type: "approved",
            issuer: "https://auth.example.com",
            endpointOrigins: confirmedEndpointOrigins,
          },
        }),
        safeDb: makeSafeDb(),
        userId,
        outboundFetch,
        dependencies: {
          ...connectionDependencies,
          discoverOAuthMetadata: async ({
            rawMcpUrl: url,
            confirmedEndpointOrigins: origins,
          }) => {
            observedOrigins = origins;
            return await connectionDependenciesTestDouble.discoverOAuthMetadata(
              {
                rawMcpUrl: url,
                permit: outboundPermit,
              },
            );
          },
        },
      }),
    ).not.toBeNull();
    expect(observedOrigins).toEqual(confirmedEndpointOrigins);
  });

  test("coordinates concurrent attempts for an expired connection", async () => {
    const safeDb = makeSafeDb();
    const row = oauthRow();
    const clients = await Promise.all([
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
    ]);
    expect(state.refreshCalls).toBe(1);
    expect(clients.every((client) => client !== null)).toBe(true);
  });

  test("uses the current token during a coordinated refresh interval", async () => {
    const safeDb = makeSafeDb();
    const row = oauthRow({ expiresAt: new Date(state.now.getTime() + 30_000) });
    const clients = await Promise.all([
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
      createMcpClientForConnection({ organizationId, row, safeDb, userId }),
    ]);
    expect(state.refreshCalls).toBe(1);
    expect(clients.every((client) => client !== null)).toBe(true);
    expect(
      state.transports.map((transport) => transport.headers?.["Authorization"]),
    ).toContain("Bearer decrypted-mcp_access_token");
  });

  test("bounds the wait for an existing refresh", async () => {
    const safeDb = makeSafeDb();
    const row = oauthRow();
    const { claimMcpRefreshLease } =
      await import("@/api/lib/mcp-upstream/connections");
    Result.unwrap(
      await claimMcpRefreshLease({
        safeDb,
        organizationId,
        userId,
        connectionId: row.userConnectionId,
        now: state.now,
      }),
    );
    let waitedMilliseconds = 0;
    const client = await createMcpClientForConnectionImpl({
      organizationId,
      permit: outboundPermit,
      row,
      safeDb,
      userId,
      outboundFetch,
      dependencies: {
        ...connectionDependencies,
        wait: async (milliseconds) => {
          waitedMilliseconds += milliseconds;
        },
      },
    });
    expect(client).toBeNull();
    expect(waitedMilliseconds).toBe(2000);
    expect(state.refreshCalls).toBe(0);
  });

  test("uses the token another attempt refreshed while this one waited", async () => {
    const safeDb = makeSafeDb();
    const row = oauthRow();
    const { claimMcpRefreshLease } =
      await import("@/api/lib/mcp-upstream/connections");
    Result.unwrap(
      await claimMcpRefreshLease({
        safeDb,
        organizationId,
        userId,
        connectionId: row.userConnectionId,
        now: state.now,
      }),
    );
    const client = await createMcpClientForConnectionImpl({
      organizationId,
      permit: outboundPermit,
      row,
      safeDb,
      userId,
      outboundFetch,
      dependencies: {
        ...connectionDependencies,
        // Returns the stored ciphertext so the assertion sees which token was read.
        decryptMcpSecret: asTestRaw<
          (typeof connectionDependencies)["decryptMcpSecret"]
        >(async ({ ciphertext }: { ciphertext: Buffer }) =>
          ciphertext.toString(),
        ),
        // The lease holder stores a fresh token during the first wait.
        wait: async () => {
          Result.unwrap(
            await safeDb(async (tx) => {
              await tx
                .update(mcpUserConnections)
                .set({
                  accessTokenEncrypted: Buffer.from("rotated-token"),
                  expiresAt: new Date(state.now.getTime() + 3_600_000),
                  refreshLeaseExpiresAt: null,
                })
                .where(undefined);
            }),
          );
        },
      },
    });
    expect(client).not.toBeNull();
    expect(state.refreshCalls).toBe(0);
    expect(
      state.transports.map((transport) => transport.headers?.["Authorization"]),
    ).toEqual(["Bearer rotated-token"]);
  });

  test("defers retryable refresh outcomes", async () => {
    state.refresh = () =>
      Result.err(
        new HandlerError({
          status: 502,
          message: "Token endpoint unavailable",
        }),
      );
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
    expect(state.refreshCalls).toBe(1);
    expect(hasStatusSet("needs_reauth")).toBe(false);
    expect(
      state.dbSets.some((set) => set["refreshRetryAfter"] instanceof Date),
    ).toBe(true);
  });

  test("resumes metadata discovery after a bounded retry interval", async () => {
    let metadataFetches = 0;
    let stalled = true;
    let failureCode: string | undefined;
    const safeDb = makeSafeDb();
    const row = oauthRow();
    const dependencies = {
      ...connectionDependencies,
      discoverOAuthMetadata: async ({
        rawMcpUrl: connectorUrl,
      }: Parameters<typeof discoverOAuthMetadata>[0]) => {
        if (!stalled) {
          return await connectionDependenciesTestDouble.discoverOAuthMetadata({
            rawMcpUrl: connectorUrl,
            permit: outboundPermit,
          });
        }
        const result = await discoverOAuthMetadata({
          rawMcpUrl: connectorUrl,
          permit: outboundPermit,
          dependencies: {
            timeoutMs: 5,
            validateOutboundFetchTarget: async (rawUrl: string | URL) =>
              Result.ok({ url: new URL(rawUrl), addresses: [] }),
            safeOutboundFetchBytes: async () => {
              metadataFetches += 1;
              return await new Promise<never>(() => {});
            },
          },
        });
        if (Result.isError(result)) {
          failureCode = result.error.code;
        }
        return result;
      },
    };
    const create = async () =>
      await createMcpClientForConnectionImpl({
        organizationId,
        permit: outboundPermit,
        row,
        safeDb,
        userId,
        outboundFetch,
        dependencies,
      });
    const concurrent = await Promise.all([create(), create()]);
    expect(concurrent).toEqual([null, null]);
    expect(metadataFetches).toBe(1);
    expect(failureCode).toBe(MCP_OAUTH_DISCOVERY_TIMEOUT_CODE);
    expect(hasStatusSet("needs_reauth")).toBe(false);
    expect(hasStatusSet("needs_approval")).toBe(false);
    expect(await create()).toBeNull();
    expect(metadataFetches).toBe(1);
    state.now = new Date(state.now.getTime() + MCP_REFRESH_BACKOFF_MS + 1);
    stalled = false;
    expect(await create()).not.toBeNull();
    expect(state.refreshCalls).toBe(1);
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
    oauthConnectorIssuer: "https://auth.example.com",
    oauthConnectorConfirmedEndpointOrigins: [],
    oauthReviewApprovedIssuer: null,
    oauthReviewApprovedEndpointOrigins: null,
    oauthClientId: "client-1",
    oauthClientSecretEncrypted: null,
    oauthClientSecretIv: null,
    oauthResourceUrl: "https://mcp.example.com/rpc",
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

    expect(loaded.map((row) => `${row.userConnectionId}:${row.type}`)).toEqual([
      "conn_1:oauth2",
      "conn_3:none",
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
