import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  bindDiscoveredMetadata,
  buildAuthorizeUrl,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  validateApprovedOAuthIssuer,
  buildMcpClientMetadataDocument,
  buildOAuthClientRegistrationRequest,
  clientRegistrationMode,
  getMcpClientMetadataDocumentUrl,
  getMcpOAuthRedirectUri,
  tokenExpiresAt,
} from "@/api/lib/mcp-upstream/oauth";
import type {
  UpstreamAuthorizationServerMetadata,
  TokenResponse,
} from "@/api/lib/mcp-upstream/oauth";
import { redactMcpOAuthRegistrationResponse } from "@/api/lib/mcp-upstream/oauth-registration-response";
import { canonicalMcpResourceUrl } from "@/api/lib/mcp-upstream/url-safety";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const connectorUrl = "https://mcp.example.com/rpc";
const issuer = "https://as.example.com";

const discoveryTransport = ({
  resource = connectorUrl,
  metadataIssuer = issuer,
  responseIssuerSupported = false,
} = {}) => {
  const requests: { url: string; method: string }[] = [];
  const dependencies = {
    validateOutboundFetchTarget: async (url: string | URL) =>
      Result.ok({ addresses: [], url: new URL(url) }),
    safeOutboundFetchBytes: async ({
      url,
      method,
    }: {
      url: URL;
      method?: string;
    }) => {
      requests.push({ url: url.toString(), method: method ?? "GET" });
      const responseData = () => {
        if (method === "POST") {
          return { access_token: "access", token_type: "Bearer" };
        }
        if (url.hostname === "mcp.example.com") {
          return { resource, authorization_servers: [issuer] };
        }
        return {
          issuer: metadataIssuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          authorization_response_iss_parameter_supported:
            responseIssuerSupported,
        };
      };
      return Result.ok({
        body: new TextEncoder().encode(JSON.stringify(responseData())).buffer,
        headers: new Headers({ "Content-Type": "application/json" }),
        ok: true,
        status: 200,
      });
    },
  } satisfies Parameters<typeof discoverOAuthMetadata>[1];
  return { dependencies, requests };
};

describe("upstream metadata binding", () => {
  test("uses only metadata issued for the connector", async () => {
    const transport = discoveryTransport({
      resource: "https://mcp.example.com/other",
    });
    const result = await discoverOAuthMetadata(
      connectorUrl,
      transport.dependencies,
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(502);
      expect(result.error.message).toContain("resource metadata");
    }
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests.every(({ method }) => method === "GET")).toBe(
      true,
    );
  });

  test("uses only metadata issued by the selected server", async () => {
    const transport = discoveryTransport({
      metadataIssuer: "https://as.example.com/other",
    });
    const result = await discoverOAuthMetadata(
      connectorUrl,
      transport.dependencies,
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(502);
      expect(result.error.message).toContain("selected issuer");
    }
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every(({ method }) => method === "GET")).toBe(
      true,
    );
  });

  test("builds authorization requests from configured metadata", async () => {
    const transport = discoveryTransport();
    const result = await discoverOAuthMetadata(
      connectorUrl,
      transport.dependencies,
    );
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    const url = new URL(
      buildAuthorizeUrl({
        metadata: result.value,
        clientId: "client",
        codeChallenge: "challenge",
        connectorSlug: "registry",
        redirectUri: "https://app.example.com/callback",
        requestedScopes: ["read"],
        state: "state",
      }),
    );
    expect(url.origin).toBe(issuer);
    expect(url.searchParams.get("resource")).toBe(connectorUrl);
    expect(url.searchParams.get("scope")).toBe("read");
    expect(Result.isOk(validateApprovedOAuthIssuer(result.value, null))).toBe(
      true,
    );
    expect(Result.isOk(validateApprovedOAuthIssuer(result.value, issuer))).toBe(
      true,
    );
    const approval = validateApprovedOAuthIssuer(
      result.value,
      `${issuer}/other`,
    );
    expect(Result.isError(approval)).toBe(true);
    if (Result.isError(approval)) {
      expect(approval.error.status).toBe(409);
      expect(approval.error.code).toBe("mcp_authorization_approval_required");
    }
  });

  test("mcp-resource-url.equivalence", () => {
    assertProperty(
      "mcp-resource-url.equivalence",
      fc.property(
        fc.record({
          scheme: fc.constantFrom("http", "https"),
          host: fc.integer({ min: 1, max: 100_000 }),
          path: fc.integer({ min: 1, max: 100_000 }),
          equivalent: fc.boolean(),
          distinctPart: fc.constantFrom("path", "query", "port", "host"),
          slashes: fc.integer({ min: 1, max: 4 }),
        }),
        ({ scheme, host, path, equivalent, slashes, distinctPart }) => {
          const base = `${scheme}://server${host}.example.com/rpc${path}`;
          const distinctResources = {
            path: `${base}/other`,
            query: `${base}?mode=read`,
            port: `${scheme}://server${host}.example.com:8443/rpc${path}`,
            host: `${scheme}://other${host}.example.com/rpc${path}`,
          };
          const resource = equivalent
            ? `${scheme.toUpperCase()}://SERVER${host}.EXAMPLE.COM:${scheme === "https" ? 443 : 80}/rpc${path}${"/".repeat(slashes)}`
            : distinctResources[distinctPart];
          expect(resource).not.toBe(base);
          expect(
            canonicalMcpResourceUrl(resource) === canonicalMcpResourceUrl(base),
          ).toBe(equivalent);
          expect(
            canonicalMcpResourceUrl(canonicalMcpResourceUrl(resource)),
          ).toBe(canonicalMcpResourceUrl(resource));
          const binding = bindDiscoveredMetadata({
            connectorUrl: base,
            protectedResource: { resource, authorization_servers: [issuer] },
            authorizationServer: authorizationServer({}),
          });
          expect(Result.isOk(binding)).toBe(equivalent);
        },
      ),
    );
  });
});

describe("authorization response metadata", () => {
  for (const supported of [false, true]) {
    for (const responseIssuer of [undefined, issuer, `${issuer}/other`]) {
      const presentKind = responseIssuer === issuer ? "matching" : "different";
      const responseKind =
        responseIssuer === undefined ? "absent" : presentKind;
      test(`processes configured issuer responses (${supported}, ${responseKind})`, async () => {
        const transport = discoveryTransport({
          responseIssuerSupported: supported,
        });
        const metadata = await discoverOAuthMetadata(
          connectorUrl,
          transport.dependencies,
        );
        expect(Result.isOk(metadata)).toBe(true);
        if (Result.isError(metadata)) {
          return;
        }
        const result = await exchangeAuthorizationCode({
          metadata: metadata.value,
          dependencies: transport.dependencies,
          clientId: "client",
          clientSecret: null,
          code: "code",
          codeVerifier: "verifier",
          responseIssuer,
          redirectUri: "https://app.example.com/callback",
        });
        const valid = !supported || responseIssuer === issuer;
        expect(Result.isOk(result)).toBe(valid);
        expect(
          transport.requests.filter(({ method }) => method === "POST"),
        ).toHaveLength(valid ? 1 : 0);
        if (Result.isError(result)) {
          expect(result.error.status).toBe(502);
          expect(result.error.message).toContain("response issuer");
        }
      });
    }
  }
});

const authorizationServer = (
  overrides: Partial<UpstreamAuthorizationServerMetadata>,
): UpstreamAuthorizationServerMetadata => ({
  issuer: "https://as.example.com",
  authorization_endpoint: "https://as.example.com/authorize",
  token_endpoint: "https://as.example.com/token",
  ...overrides,
});

describe("clientRegistrationMode", () => {
  test("prefers CIMD when the server advertises support", () => {
    expect(
      clientRegistrationMode(
        authorizationServer({
          client_id_metadata_document_supported: true,
          registration_endpoint: "https://as.example.com/register",
        }),
      ),
    ).toBe("cimd");
  });

  test("falls back to dynamic registration when only DCR is offered", () => {
    expect(
      clientRegistrationMode(
        authorizationServer({
          registration_endpoint: "https://as.example.com/register",
        }),
      ),
    ).toBe("dcr");
  });

  test("reports unsupported when neither mechanism is offered", () => {
    expect(clientRegistrationMode(authorizationServer({}))).toBe("unsupported");
    expect(
      clientRegistrationMode(
        authorizationServer({
          client_id_metadata_document_supported: false,
        }),
      ),
    ).toBe("unsupported");
  });
});

describe("buildMcpClientMetadataDocument", () => {
  test("client_id equals the URL the document is served from", () => {
    const document = buildMcpClientMetadataDocument();

    expect(document.client_id).toBe(getMcpClientMetadataDocumentUrl());
    expect(new URL(document.client_id).pathname).toBe(
      "/v1/mcp/oauth/client-metadata.json",
    );
  });

  test("describes a public client without any shared secret", () => {
    const document = buildMcpClientMetadataDocument();

    expect(document.token_endpoint_auth_method).toBe("none");
    expect(document.redirect_uris).toEqual([getMcpOAuthRedirectUri()]);
    expect(Object.keys(document)).not.toContain("client_secret");
  });
});

describe("buildOAuthClientRegistrationRequest", () => {
  const registrationInput = {
    clientUri: "https://app.example.com",
    connectorSlug: "example-connector",
    redirectUri: "https://app.example.com/api/mcp-upstream/callback",
    requestedScopes: ["openid", "profile"],
  };

  test("registers a public client that names the connector it is for", () => {
    const request = buildOAuthClientRegistrationRequest(registrationInput);

    expect(request).toEqual({
      client_name: "stella",
      client_uri: "https://app.example.com",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://app.example.com/api/mcp-upstream/callback"],
      response_types: ["code"],
      scope: "openid profile",
      software_id: "stella-example-connector",
      token_endpoint_auth_method: "none",
    });
  });

  test("omits contacts and scope rather than sending them empty", () => {
    // RFC 7591 §2 makes both optional, and an authorization server that
    // rejects an empty array would refuse the whole registration.
    const request = buildOAuthClientRegistrationRequest({
      ...registrationInput,
      requestedScopes: [],
    });

    expect(Object.keys(request)).not.toContain("contacts");
    expect(Object.keys(request)).not.toContain("scope");
  });
});

describe("redactMcpOAuthRegistrationResponse", () => {
  test("removes client credentials from dynamic registration metadata", () => {
    const redacted = redactMcpOAuthRegistrationResponse({
      client_id: "client-123",
      client_secret: "secret",
      nested: {
        registration_access_token: "token",
        safe_value: "kept",
      },
      token_endpoint_auth_method: "none",
    });

    expect(redacted).toEqual({
      client_id: "client-123",
      client_secret: "[redacted]",
      nested: {
        registration_access_token: "[redacted]",
        safe_value: "kept",
      },
      token_endpoint_auth_method: "none",
    });
  });

  test("redacts secrets inside an array of objects, preserving siblings", () => {
    const redacted = redactMcpOAuthRegistrationResponse({
      keys: [{ client_secret: "x", kid: "ok" }],
    });
    expect(redacted).toEqual({
      keys: [{ client_secret: "[redacted]", kid: "ok" }],
    });
  });

  test("redacts suffix-matched keys case-insensitively", () => {
    const redacted = redactMcpOAuthRegistrationResponse({
      app_secret: "x",
      DB_PASSWORD: "y",
      jwt_assertion: "z",
      keep_me: "ok",
    });
    expect(redacted).toEqual({
      app_secret: "[redacted]",
      DB_PASSWORD: "[redacted]",
      jwt_assertion: "[redacted]",
      keep_me: "ok",
    });
  });
});

describe("tokenExpiresAt", () => {
  const token = (expires_in: number | undefined): TokenResponse =>
    asTestRaw<TokenResponse>({
      access_token: "a",
      token_type: "Bearer",
      expires_in,
    });

  test("returns null when expires_in is absent or non-positive", () => {
    expect(tokenExpiresAt(token(undefined))).toBeNull();
    expect(tokenExpiresAt(token(0))).toBeNull();
    expect(tokenExpiresAt(token(-5))).toBeNull();
  });

  test("returns a future instant ~expires_in seconds out", () => {
    const before = Date.now();
    const result = tokenExpiresAt(token(3600));
    const after = Date.now();
    expect(result).not.toBeNull();
    const ms = result?.getTime() ?? 0;
    expect(ms).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(ms).toBeLessThanOrEqual(after + 3_600_000);
  });
});
