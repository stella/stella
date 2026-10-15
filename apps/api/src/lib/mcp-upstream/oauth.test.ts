import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  bindDiscoveredMetadata,
  buildAuthorizeUrl,
  discoverOAuthMetadata,
  discoverOAuthMetadataForApproval,
  getOAuthEndpointOrigins,
  endpointsRequiringConfirmation,
  oauthDomainsMatch,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  MCP_OAUTH_INVALID_GRANT_CODE,
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
import {
  canonicalMcpResourceUrl,
  mcpResourceMatchesConnector,
} from "@/api/lib/mcp-upstream/url-safety";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const connectorUrl = "https://mcp.example.com/rpc";
const issuer = "https://as.example.com";
const outboundPermit = grantThirdPartyOutboundPermit();

const discoveryTransport = ({
  resource = connectorUrl,
  metadataIssuer = issuer,
  responseIssuerSupported = false,
  tokenEndpoint = `${issuer}/token`,
} = {}) => {
  const requests: { url: string; method: string }[] = [];
  const dependencies = {
    validateOutboundFetchTarget: async (url: string | URL) =>
      Result.ok({ addresses: [], url: new URL(url) }),
    safeOutboundFetchBytes: async ({
      url: rawUrl,
      method,
    }: {
      url: string | URL;
      method?: string | undefined;
    }) => {
      const url = new URL(rawUrl);
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
          token_endpoint: tokenEndpoint,
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
  } satisfies NonNullable<
    Parameters<typeof discoverOAuthMetadata>[0]["dependencies"]
  >;
  return { dependencies, requests };
};

describe("upstream metadata binding", () => {
  test("uses confirmed endpoint origins for metadata binding", async () => {
    for (const [tokenEndpoint, confirmedEndpointOrigins, accepted] of [
      ["https://tokens.example.com/token", [], true],
      ["https://tokens.example.net/token", [], false],
      [
        "https://tokens.example.net/token",
        ["https://tokens.example.net"],
        true,
      ],
      [
        "https://tokens.example.net/token",
        ["https://tokens.example.net:8443"],
        false,
      ],
      [
        "https://tokens.example.net/token",
        ["https://other.example.net"],
        false,
      ],
      [
        "https://tokens.example.net/token",
        ["http://tokens.example.net"],
        false,
      ],
    ] as const) {
      const transport = discoveryTransport({ tokenEndpoint });
      const result = await discoverOAuthMetadata({
        rawMcpUrl: connectorUrl,
        permit: outboundPermit,
        dependencies: transport.dependencies,
        confirmedEndpointOrigins,
      });
      expect(Result.isOk(result)).toBe(accepted);
      if (Result.isError(result)) {
        expect(result.error.status).toBe(409);
        expect(result.error.code).toBe("mcp_authorization_approval_required");
      }
      const review = await discoverOAuthMetadataForApproval({
        rawMcpUrl: connectorUrl,
        permit: outboundPermit,
        dependencies: transport.dependencies,
      });
      expect(Result.isOk(review)).toBe(true);
      if (Result.isOk(review)) {
        expect(getOAuthEndpointOrigins(review.value)).toContain(
          new URL(tokenEndpoint).origin,
        );
        expect(endpointsRequiringConfirmation(review.value)).toEqual(
          new URL(tokenEndpoint).hostname === "tokens.example.net"
            ? ["https://tokens.example.net"]
            : [],
        );
      }
      expect(transport.requests.every(({ method }) => method === "GET")).toBe(
        true,
      );
    }
  });

  test("compares OAuth endpoint domains using private suffix boundaries", () => {
    for (const [first, second, matches] of [
      ["https://accounts.example.co.uk", "https://tokens.example.co.uk", true],
      ["https://first.github.io", "https://second.github.io", false],
      ["https://first.github.io", "https://tokens.first.github.io", true],
      ["http://localhost:3000", "http://localhost:4000", false],
      ["https://notexample.com", "https://example.com", false],
      ["https://example.com.evil.net", "https://example.com", false],
      ["https://192.0.2.1", "https://example.com", false],
      ["https://192.0.2.1", "https://192.0.2.2", false],
      ["https://[2001:db8::1]", "https://example.com", false],
      ["https://192.0.2.1", "https://192.0.2.1:8443", false],
    ] as const) {
      expect(oauthDomainsMatch(first, second)).toBe(matches);
    }
  });

  test("mcp-oauth-endpoints.confirmation", () => {
    assertProperty(
      "mcp-oauth-endpoints.confirmation",
      fc.property(
        fc.record({
          endpoint: fc.constantFrom(
            "authorization_endpoint",
            "token_endpoint",
            "registration_endpoint",
          ),
          domainKind: fc.constantFrom("same", "external"),
          confirmationKind: fc.constantFrom(
            "none",
            "exact",
            "scheme",
            "port",
            "host",
          ),
          subdomain: fc.integer({ min: 1, max: 100_000 }),
        }),
        ({ endpoint, domainKind, confirmationKind, subdomain }) => {
          const domain = domainKind === "same" ? "example.com" : "example.net";
          const origin = `https://endpoint${subdomain}.${domain}`;
          const confirmations = {
            none: [],
            exact: [origin],
            scheme: [`http://endpoint${subdomain}.${domain}`],
            port: [`${origin}:8443`],
            host: [`https://other${subdomain}.${domain}`],
          };
          const result = bindDiscoveredMetadata({
            connectorUrl,
            protectedResource: {
              resource: connectorUrl,
              authorization_servers: [issuer],
            },
            authorizationServer: authorizationServer({
              [endpoint]: `${origin}/endpoint`,
            }),
            confirmedEndpointOrigins: confirmations[confirmationKind],
          });
          expect(Result.isOk(result)).toBe(
            domainKind === "same" || confirmationKind === "exact",
          );
        },
      ),
    );
  });

  test("mcp-resource-url.syntax", () => {
    assertProperty(
      "mcp-resource-url.syntax",
      fc.property(
        fc.record({
          segment: fc.constantFrom(".", "..", "item"),
          encoded: fc.boolean(),
          username: fc.boolean(),
          password: fc.boolean(),
          separator: fc.constantFrom("/", "\\"),
        }),
        ({ segment, encoded, username, password, separator }) => {
          const rawSegment = encoded ? segment.replaceAll(".", "%2e") : segment;
          const credentials =
            username || password
              ? `${username ? "member" : ""}${password ? ":value" : ""}@`
              : "";
          const resourceUrl = `https://${credentials}mcp.example.com/rpc${separator}${rawSegment}`;
          const normalized = new URL(resourceUrl);
          const expected =
            !username &&
            !password &&
            !(encoded && segment !== "item") &&
            (normalized.pathname === "/" || normalized.pathname === "/rpc/");
          expect(
            mcpResourceMatchesConnector({ connectorUrl, resourceUrl }),
          ).toBe(expected);
        },
      ),
    );
  });

  test("uses only metadata issued for the connector", async () => {
    const transport = discoveryTransport({
      resource: "https://mcp.example.com/other",
    });
    const result = await discoverOAuthMetadata({
      rawMcpUrl: connectorUrl,
      permit: outboundPermit,
      dependencies: transport.dependencies,
    });
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

  test("accepts origin-level resource metadata", async () => {
    const transport = discoveryTransport({
      resource: "https://mcp.example.com",
    });
    const result = await discoverOAuthMetadata({
      rawMcpUrl: connectorUrl,
      permit: outboundPermit,
      dependencies: transport.dependencies,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.protectedResource.resource).toBe(
        "https://mcp.example.com",
      );
    }
  });

  test("accepts configured resource paths", () => {
    const configuredUrl = "https://mcp.example.com/mcp/v1";
    for (const [resourceUrl, accepted] of [
      ["https://mcp.example.com", true],
      ["https://mcp.example.com/mcp", true],
      ["https://mcp.example.com/mcp/v1/", true],
      ["https://other.example.com/mcp", false],
      ["https://mcp.example.com/other", false],
      ["https://mcp.example.com/mc", false],
    ] as const) {
      expect(
        mcpResourceMatchesConnector({
          connectorUrl: configuredUrl,
          resourceUrl,
        }),
      ).toBe(accepted);
    }
  });

  test("mcp-resource-url.segment-prefix", () => {
    assertProperty(
      "mcp-resource-url.segment-prefix",
      fc.property(
        fc.record({
          scheme: fc.constantFrom("http", "https"),
          host: fc.integer({ min: 1, max: 100_000 }),
          segments: fc.array(fc.integer({ min: 1, max: 100_000 }), {
            minLength: 1,
            maxLength: 5,
          }),
          prefixLength: fc.nat({ max: 5 }),
          pathKind: fc.constantFrom("prefix", "sibling", "partial", "child"),
          originKind: fc.constantFrom("same", "host", "scheme", "port"),
          queryKind: fc.constantFrom(
            "absent",
            "same",
            "different",
            "reordered",
          ),
          queryVersion: fc.integer({ min: 1, max: 100_000 }),
          slashes: fc.nat({ max: 3 }),
        }),
        ({
          scheme,
          host,
          segments,
          prefixLength,
          pathKind,
          originKind,
          queryKind,
          queryVersion,
          slashes,
        }) => {
          const parts = segments.map((part) => `rpc${part}segment`);
          const connectorPath = `/${parts.join("/")}`;
          const prefix = parts.slice(0, prefixLength);
          const resourcePaths = {
            prefix: `/${prefix.join("/")}`,
            sibling: "/other",
            partial: connectorPath.slice(0, -1),
            child: `${connectorPath}/other`,
          };
          const resourceOrigins = {
            same: `${scheme.toUpperCase()}://SERVER${host}.EXAMPLE.COM:${scheme === "https" ? 443 : 80}`,
            host: `${scheme}://other${host}.example.com`,
            scheme: `${scheme === "https" ? "http" : "https"}://server${host}.example.com`,
            port: `${scheme}://server${host}.example.com:8443`,
          };
          const query = `?version=${queryVersion}&mode=read`;
          const resourceQueries = {
            absent: "",
            same: query,
            different: `?version=${queryVersion + 1}&mode=read`,
            reordered: `?mode=read&version=${queryVersion}`,
          };
          const configuredUrl = `${scheme}://server${host}.example.com${connectorPath}${query}`;
          const resourceUrl = `${resourceOrigins[originKind]}${resourcePaths[pathKind]}${"/".repeat(slashes)}${resourceQueries[queryKind]}`;
          const expected =
            originKind === "same" &&
            pathKind === "prefix" &&
            (queryKind === "absent" || queryKind === "same");
          expect(
            mcpResourceMatchesConnector({
              connectorUrl: configuredUrl,
              resourceUrl,
            }),
          ).toBe(expected);
          const binding = bindDiscoveredMetadata({
            connectorUrl: configuredUrl,
            protectedResource: {
              resource: resourceUrl,
              authorization_servers: [issuer],
            },
            authorizationServer: authorizationServer({}),
          });
          expect(Result.isOk(binding)).toBe(expected);
        },
      ),
    );
  });

  test("uses only metadata issued by the selected server", async () => {
    const transport = discoveryTransport({
      metadataIssuer: "https://as.example.com/other",
    });
    const result = await discoverOAuthMetadata({
      rawMcpUrl: connectorUrl,
      permit: outboundPermit,
      dependencies: transport.dependencies,
    });
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
    const result = await discoverOAuthMetadata({
      rawMcpUrl: connectorUrl,
      permit: outboundPermit,
      dependencies: transport.dependencies,
    });
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
    expect(
      Result.isOk(
        validateApprovedOAuthIssuer(result.value, {
          type: "approved",
          issuer,
          endpointOrigins: [],
        }),
      ),
    ).toBe(true);
    for (const approvedIssuer of [
      `${issuer}/other`,
      `${issuer}/`,
      "https://AS.example.com",
      "https://as.example.com:443",
      "http://as.example.com",
    ]) {
      const approval = validateApprovedOAuthIssuer(result.value, {
        type: "approved",
        issuer: approvedIssuer,
        endpointOrigins: [],
      });
      expect(Result.isError(approval)).toBe(true);
      if (Result.isError(approval)) {
        expect(approval.error.status).toBe(409);
        expect(approval.error.code).toBe("mcp_authorization_approval_required");
      }
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
        },
      ),
    );
  });
});

test("classifies refresh outcomes from the token endpoint", async () => {
  for (const [status, error, definitive] of [
    [400, "invalid_grant", true],
    [503, "temporarily_unavailable", false],
    [400, "invalid_client", false],
  ] as const) {
    const transport = discoveryTransport();
    const metadata = await discoverOAuthMetadata({
      rawMcpUrl: connectorUrl,
      permit: outboundPermit,
      dependencies: transport.dependencies,
    });
    expect(Result.isOk(metadata)).toBe(true);
    if (Result.isError(metadata)) {
      return;
    }
    const result = await refreshOAuthToken({
      metadata: metadata.value,
      permit: outboundPermit,
      dependencies: {
        ...transport.dependencies,
        safeOutboundFetchBytes: async () =>
          Result.ok({
            body: new TextEncoder().encode(JSON.stringify({ error })).buffer,
            headers: new Headers(),
            ok: false,
            status,
          }),
      },
      clientId: "client",
      clientSecret: null,
      refreshToken:
        asTestRaw<Parameters<typeof refreshOAuthToken>[0]["refreshToken"]>(
          "refresh",
        ),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code === MCP_OAUTH_INVALID_GRANT_CODE).toBe(
        definitive,
      );
    }
  }
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
        const metadata = await discoverOAuthMetadata({
          rawMcpUrl: connectorUrl,
          permit: outboundPermit,
          dependencies: transport.dependencies,
        });
        expect(Result.isOk(metadata)).toBe(true);
        if (Result.isError(metadata)) {
          return;
        }
        const result = await exchangeAuthorizationCode({
          metadata: metadata.value,
          permit: outboundPermit,
          dependencies: transport.dependencies,
          clientId: "client",
          clientSecret: null,
          code: "code",
          codeVerifier: "verifier",
          responseIssuer,
          redirectUri: "https://app.example.com/callback",
        });
        const valid =
          responseIssuer === issuer ||
          (!supported && responseIssuer === undefined);
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
