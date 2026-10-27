import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import {
  bindDiscoveredMetadata,
  revokeOAuthToken,
} from "@/api/lib/mcp-upstream/oauth";
import type { BoundOAuthMetadata } from "@/api/lib/mcp-upstream/oauth";
import { revokeMcpConnectionTokens } from "@/api/lib/mcp-upstream/revocation";
import type { McpTokenRevocationDependencies } from "@/api/lib/mcp-upstream/revocation";
import type { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");
const connectorUrl = "https://mcp.example.com/mcp";
const issuer = "https://auth.example.com";

const boundMetadata = (
  extra: Record<string, unknown> = {},
  confirmedEndpointOrigins: readonly string[] = [],
): BoundOAuthMetadata => {
  const bound = bindDiscoveredMetadata({
    connectorUrl,
    protectedResource: {
      resource: connectorUrl,
      authorization_servers: [issuer],
    },
    authorizationServer: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      ...extra,
    },
    confirmedEndpointOrigins,
  });
  if (Result.isError(bound)) {
    throw bound.error;
  }
  return bound.value;
};

const oauthConnection = (
  overrides: Partial<Extract<LoadedMcpConnection, { type: "oauth2" }>> = {},
): LoadedMcpConnection => ({
  type: "oauth2",
  responseDisposition: "normal",
  allowedTools: null,
  connectorId: toSafeId<"mcpConnector">("connector_1"),
  description: "",
  displayName: "Registry",
  slug: "registry",
  url: connectorUrl,
  userConnectionId: toSafeId<"mcpUserConnection">("connection_1"),
  accessTokenEncrypted: Buffer.from("access"),
  accessTokenIv: Buffer.from("iv"),
  expiresAt: null,
  oauthAuthorizationServerUrl: issuer,
  oauthIssuerBinding: { type: "approved", issuer, endpointOrigins: [] },
  oauthClientId: "client-1",
  oauthClientSecretEncrypted: Buffer.from("secret"),
  oauthClientSecretIv: Buffer.from("iv"),
  oauthResourceUrl: connectorUrl,
  refreshTokenEncrypted: Buffer.from("refresh"),
  refreshTokenIv: Buffer.from("iv"),
  ...overrides,
});

type RevokeCall = Parameters<typeof revokeOAuthToken>[0];

const fakeDependencies = ({
  metadata = boundMetadata({ revocation_endpoint: `${issuer}/revoke` }),
  revoke = async () => await Promise.resolve(Result.ok(undefined)),
}: {
  metadata?: BoundOAuthMetadata | HandlerError<502>;
  revoke?: (call: RevokeCall) => ReturnType<typeof revokeOAuthToken>;
} = {}) => {
  const revokeCalls: RevokeCall[] = [];
  let discoveries = 0;
  const dependencies: McpTokenRevocationDependencies = {
    decryptMcpSecret: asTestRaw<
      McpTokenRevocationDependencies["decryptMcpSecret"]
    >(
      async ({ purpose }: { purpose: string }) =>
        await Promise.resolve(`decrypted:${purpose}`),
    ),
    discoverOAuthMetadata: async () => {
      discoveries += 1;
      return await Promise.resolve(
        metadata instanceof HandlerError
          ? Result.err(metadata)
          : Result.ok(metadata),
      );
    },
    revokeOAuthToken: async (call) => {
      revokeCalls.push(call);
      return await revoke(call);
    },
  };
  return { dependencies, revokeCalls, discoveries: () => discoveries };
};

const run = async (
  connection: LoadedMcpConnection,
  dependencies: McpTokenRevocationDependencies,
) =>
  await revokeMcpConnectionTokens({
    connection,
    dependencies,
    organizationId,
    permit: grantThirdPartyOutboundPermit(),
    userId,
  });

describe("upstream token revocation on disconnect", () => {
  test("revokes the refresh token, then the access token, with the registered client", async () => {
    const fixture = fakeDependencies();

    const outcome = await run(oauthConnection(), fixture.dependencies);

    expect(outcome).toEqual({
      type: "attempted",
      revoked: ["refresh_token", "access_token"],
      failed: [],
    });
    expect(
      fixture.revokeCalls.map((call) => ({
        clientId: call.clientId,
        clientSecret:
          call.clientSecret === null ? null : String(call.clientSecret),
        endpoint: call.endpoint.toString(),
        token: String(call.revocable.token),
        tokenTypeHint: call.revocable.tokenTypeHint,
      })),
    ).toEqual([
      {
        clientId: "client-1",
        clientSecret: "decrypted:mcp_client_secret",
        endpoint: `${issuer}/revoke`,
        token: "decrypted:mcp_refresh_token",
        tokenTypeHint: "refresh_token",
      },
      {
        clientId: "client-1",
        clientSecret: "decrypted:mcp_client_secret",
        endpoint: `${issuer}/revoke`,
        token: "decrypted:mcp_access_token",
        tokenTypeHint: "access_token",
      },
    ]);
  });

  test("a failed refresh revocation still attempts the access token", async () => {
    const fixture = fakeDependencies({
      revoke: async (call) => {
        if (call.revocable.tokenTypeHint === "refresh_token") {
          throw new Error("connection reset");
        }
        return await Promise.resolve(Result.ok(undefined));
      },
    });

    const outcome = await run(oauthConnection(), fixture.dependencies);

    expect(outcome).toMatchObject({
      type: "attempted",
      revoked: ["access_token"],
      failed: [{ tokenType: "refresh_token" }],
    });
  });

  test.each([
    "mcp_refresh_token",
    "mcp_access_token",
    "mcp_client_secret",
  ] as const)(
    "decryption failure for %s reports each affected token and continues",
    async (failedPurpose) => {
      const fixture = fakeDependencies();
      const decrypt = fixture.dependencies.decryptMcpSecret;
      const failure = new HandlerError({
        status: 500,
        message: "Invalid envelope",
      });
      fixture.dependencies.decryptMcpSecret = async (options) => {
        if (options.purpose === failedPurpose) {
          throw failure;
        }
        return await decrypt(options);
      };

      const outcome = await run(oauthConnection(), fixture.dependencies);

      const tokenTypes = ["refresh_token", "access_token"] as const;
      const affected = tokenTypes.filter(
        (type) =>
          failedPurpose === "mcp_client_secret" ||
          `mcp_${type}` === failedPurpose,
      );
      const unaffected = tokenTypes.filter((type) => !affected.includes(type));
      expect(outcome).toEqual({
        type: "attempted",
        revoked: unaffected,
        failed: affected.map((tokenType) => ({
          tokenType,
          error: expect.objectContaining({ cause: failure }),
        })),
      });
      expect(
        fixture.revokeCalls.map(({ revocable }) => revocable.tokenTypeHint),
      ).toEqual(unaffected);
    },
  );

  test("a public client without a refresh token revokes only the access token", async () => {
    const fixture = fakeDependencies();

    await run(
      oauthConnection({
        oauthClientSecretEncrypted: null,
        oauthClientSecretIv: null,
        refreshTokenEncrypted: null,
        refreshTokenIv: null,
      }),
      fixture.dependencies,
    );

    expect(
      fixture.revokeCalls.map((call) => [
        call.revocable.tokenTypeHint,
        call.clientSecret,
      ]),
    ).toEqual([["access_token", null]]);
  });

  test("an endpoint on an origin the approval did not confirm receives no token", async () => {
    const fixture = fakeDependencies({
      metadata: boundMetadata({
        revocation_endpoint: "https://collector.example.net/revoke",
      }),
    });

    expect(await run(oauthConnection(), fixture.dependencies)).toEqual({
      type: "skipped",
      reason: "no_revocation_endpoint",
    });
    expect(fixture.revokeCalls).toEqual([]);
  });

  test("tokens recorded under another authorization server are not sent", async () => {
    const fixture = fakeDependencies();

    expect(
      await run(
        oauthConnection({
          oauthAuthorizationServerUrl: "https://previous-auth.example.com",
        }),
        fixture.dependencies,
      ),
    ).toEqual({ type: "skipped", reason: "issuer_mismatch" });
    expect(fixture.revokeCalls).toEqual([]);
  });

  test("connections without OAuth tokens or an approved issuer are skipped without discovery", async () => {
    const fixture = fakeDependencies();
    const bearer: LoadedMcpConnection = {
      type: "bearer",
      responseDisposition: "normal",
      allowedTools: null,
      connectorId: toSafeId<"mcpConnector">("connector_1"),
      description: "",
      displayName: "Registry",
      slug: "registry",
      url: connectorUrl,
      userConnectionId: toSafeId<"mcpUserConnection">("connection_1"),
      staticTokenEncrypted: Buffer.from("static"),
      staticTokenIv: Buffer.from("iv"),
    };

    expect(await run(bearer, fixture.dependencies)).toEqual({
      type: "skipped",
      reason: "not_oauth",
    });
    expect(
      await run(
        oauthConnection({ oauthIssuerBinding: { type: "unconfigured" } }),
        fixture.dependencies,
      ),
    ).toEqual({ type: "skipped", reason: "issuer_unapproved" });
    expect(fixture.discoveries()).toBe(0);
  });

  test("discovery failure is reported, not thrown", async () => {
    const failure = new HandlerError({
      status: 502,
      code: "internal_error",
      message: "unreachable",
    });
    const fixture = fakeDependencies({ metadata: failure });

    expect(await run(oauthConnection(), fixture.dependencies)).toEqual({
      type: "discovery_failed",
      error: failure,
    });
  });
});

describe("RFC 7009 revocation request", () => {
  const requestFixture = (status: number) => {
    const requests: Parameters<typeof safeOutboundFetchBytes>[0][] = [];
    const fetchBytes: typeof safeOutboundFetchBytes = async (request) => {
      requests.push(request);
      return await Promise.resolve(
        Result.ok({
          body: new ArrayBuffer(0),
          headers: new Headers(),
          ok: status >= 200 && status < 300,
          status,
        }),
      );
    };
    return { fetchBytes, requests };
  };

  test("posts the token, its type hint and client_secret_post credentials", async () => {
    const { fetchBytes, requests } = requestFixture(200);

    const result = await revokeOAuthToken({
      clientId: "client-1",
      clientSecret: asTestRaw("client-secret"),
      dependencies: {
        safeOutboundFetchBytes: fetchBytes,
        validateOutboundFetchTarget: async () =>
          await Promise.reject(new Error("unused")),
      },
      endpoint: new URL(`${issuer}/revoke`),
      permit: grantThirdPartyOutboundPermit(),
      revocable: {
        token: asTestRaw("refresh-1"),
        tokenTypeHint: "refresh_token",
      },
    });

    expect(Result.isOk(result)).toBe(true);
    const request = requests.at(0);
    expect(request?.method).toBe("POST");
    expect(String(request?.url)).toBe(`${issuer}/revoke`);
    const body = request?.body;
    if (!(body instanceof URLSearchParams)) {
      expect.unreachable("Expected form body");
    }
    expect(Object.fromEntries(body)).toEqual({
      token: "refresh-1",
      token_type_hint: "refresh_token",
      client_id: "client-1",
      client_secret: "client-secret",
    });
  });

  test("a public client sends no secret and a non-2xx answer is an error", async () => {
    const { fetchBytes, requests } = requestFixture(503);

    const result = await revokeOAuthToken({
      clientId: "client-1",
      clientSecret: null,
      dependencies: {
        safeOutboundFetchBytes: fetchBytes,
        validateOutboundFetchTarget: async () =>
          await Promise.reject(new Error("unused")),
      },
      endpoint: new URL(`${issuer}/revoke`),
      permit: grantThirdPartyOutboundPermit(),
      revocable: {
        token: asTestRaw("access-1"),
        tokenTypeHint: "access_token",
      },
    });

    expect(Result.isError(result)).toBe(true);
    const body = requests.at(0)?.body;
    if (!(body instanceof URLSearchParams)) {
      expect.unreachable("Expected form body");
    }
    expect(body.has("client_secret")).toBe(false);
  });
});
