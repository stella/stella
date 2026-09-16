/**
 * RFC 7591 dynamic client registration bodies as real clients send them.
 *
 * The census exists because every field a client sends is self-asserted and
 * optional (RFC 7591 §2): a registration the authorization server refuses
 * surfaces to the user as a dead connector before authorization can start, so
 * the accepted set is a contract, not an implementation detail.
 *
 * The `captured` fixtures are request bodies recorded on 2026-09-16 from the
 * named client software registering against this endpoint. Volatile values
 * (callback ports, connector ids, generated `software_id`) are replaced with
 * stable placeholders of the same shape so the census is deterministic.
 * Append a newly captured payload here rather than asserting it inline.
 */

import {
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_PROTOCOL_SCOPES,
} from "@stll/api-contract";

import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";

/** A registration body the server must accept, labelled by its client. */
type OAuthClientRegistrationFixture = {
  /** The client software that sends this shape. */
  client: string;
  /**
   * Where the body came from: `captured` is evidence from a client in the
   * wild, `repository` is a body this repository itself sends, `documented`
   * is reconstructed from a vendor's published registration constraints
   * because the payload is not public, and `synthetic` is a shape the endpoint
   * must accept for which no capture exists yet. It rides the test name so a
   * failure says whether a real client regressed.
   */
  origin: "captured" | "documented" | "repository" | "synthetic";
  body: Record<string, unknown>;
};

/**
 * A registration body the server must refuse, with the RFC 7591 §3.2.2 error
 * code it must answer with. Leniency at the boundary must not erode these.
 */
type OAuthClientRegistrationRejectionFixture = {
  client: string;
  body: Record<string, unknown>;
  /** RFC 7591 §3.2.2 `error` value. */
  error: "invalid_client_metadata" | "invalid_redirect_uri";
};

/**
 * Clients ask for what discovery advertises, so the requested scope strings are
 * derived from the same constants that build the metadata document. A renamed
 * or added scope then moves the census with it instead of leaving a frozen
 * string that agrees with the server only until the next scope change.
 */
const ALL_RESOURCE_SCOPES_WITH_REFRESH = [
  ...MCP_DEFAULT_RESOURCE_SCOPES,
  "offline_access",
].join(" ");

/** Every scope the authorization server advertises, protocol scopes included. */
const EVERY_ADVERTISED_SCOPE = MCP_OAUTH_SCOPES.join(" ");

const HOSTED_CLIENT_BODY = {
  application_type: "web",
  client_name: "Example hosted connector",
  client_uri: "https://connector.example.com",
  grant_types: ["authorization_code", "refresh_token"],
  logo_uri: "https://connector.example.com/logo.png",
  redirect_uris: ["https://connector.example.com/oauth/callback"],
  response_types: ["code"],
  scope: MCP_OAUTH_PROTOCOL_SCOPES.join(" "),
  token_endpoint_auth_method: "client_secret_post",
} as const;

export const OAUTH_CLIENT_REGISTRATION_FIXTURES = {
  claudeWebConnector: {
    client: "Claude web connector",
    origin: "captured",
    body: {
      application_type: "web",
      client_name: "Claude",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      response_types: ["code"],
      scope: ALL_RESOURCE_SCOPES_WITH_REFRESH,
      token_endpoint_auth_method: "client_secret_post",
    },
  },
  chatgptConnector: {
    // States no `application_type`, so the provider's `web` default has to be
    // right for an https callback.
    client: "ChatGPT developer-mode connector",
    origin: "captured",
    body: {
      client_name: "ChatGPT",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://chatgpt.com/connector/oauth/placeholder1"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  },
  codexCli: {
    // Asks for every scope discovery advertises on the first attempt, so the
    // whole advertised set must be registerable in one request.
    client: "Codex CLI",
    origin: "captured",
    body: {
      application_type: "native",
      client_name: "Codex",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["http://127.0.0.1:50000/callback"],
      response_types: ["code"],
      scope: EVERY_ADVERTISED_SCOPE,
      token_endpoint_auth_method: "none",
    },
  },
  mcpCliProxy: {
    client: "mcp-remote MCP CLI Proxy",
    origin: "captured",
    body: {
      application_type: "native",
      client_name: "MCP CLI Proxy",
      client_uri: "https://github.com/modelcontextprotocol/mcp-cli",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["http://localhost:21000/oauth/callback"],
      response_types: ["code"],
      scope: ALL_RESOURCE_SCOPES_WITH_REFRESH,
      software_id: "00000000-0000-4000-8000-000000000000",
      software_version: "0.14.2",
      token_endpoint_auth_method: "none",
    },
  },
  browserE2e: {
    // apps/web/e2e/specs/oauth-ui-redirect.spec.ts. `require_pkce` is
    // server-owned registration policy, so the provider must ignore the key
    // rather than honour or reject it.
    client: "browser e2e redirect spec",
    origin: "repository",
    body: {
      application_type: "native",
      client_name: "OAuth redirect browser test",
      grant_types: ["authorization_code"],
      redirect_uris: ["http://127.0.0.1:33418/callback"],
      require_pkce: true,
      response_types: ["code"],
      scope: "openid profile",
      token_endpoint_auth_method: "none",
    },
  },
  stellaUpstreamConnector: {
    // apps/api/src/lib/mcp-upstream/oauth.ts `registerOAuthClient`: what stella
    // sends when it is the client registering against another server.
    client: "stella upstream MCP connector",
    origin: "repository",
    body: {
      client_name: "stella",
      client_uri: "https://app.example.com",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://app.example.com/api/mcp-upstream/callback"],
      response_types: ["code"],
      scope: "openid profile offline_access",
      software_id: "stella-example-connector",
      token_endpoint_auth_method: "none",
    },
  },
  microsoftEnterpriseTokenStore: {
    /**
     * Microsoft 365 Copilot and Copilot Studio register through Microsoft's
     * Enterprise token store, not from the end user's client, and the exact
     * payload is not published. This encodes the constraints their
     * documentation does state (learn.microsoft.com,
     * plugin-authentication-dynamic-client-registration, updated 2026-08-31):
     * registration must issue a client secret, because "DCR without a client
     * secret isn't supported yet"; PKCE is on by default; and the callbacks are
     * the fixed Teams and Copilot Studio consent hosts. Replace it with a
     * capture once one exists.
     *
     * `token_endpoint_auth_method` is deliberately absent: their side supports
     * only `client_secret_post` and `client_secret_basic`, and a registrar that
     * omits the field must land on the provider's confidential-client default
     * rather than on a public client that can never be issued a secret.
     */
    client: "Microsoft 365 Copilot (documented constraints)",
    origin: "documented",
    body: {
      client_name: "Microsoft 365 Copilot (documented constraints)",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [
        "https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect",
        "https://global.consent.azure-apim.net/redirect",
      ],
      response_types: ["code"],
    },
  },
  mcpInspector: {
    client: "MCP Inspector",
    origin: "synthetic",
    body: {
      client_name: "MCP Inspector",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["http://localhost:6274/oauth/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  },
  emptyContacts: {
    // RFC 7591 §2 makes `contacts` optional, so an empty array says exactly
    // what an absent one says. A client that always serialises the key must not
    // be refused for it.
    client: "hosted client sending contacts: []",
    origin: "synthetic",
    body: { ...HOSTED_CLIENT_BODY, contacts: [] },
  },
  unknownMetadataFields: {
    // RFC 7591 §2: the server MAY ignore client metadata it does not
    // understand. Registered-but-unmodelled and vendor-prefixed keys must not
    // fail the request or corrupt the response.
    client: "client sending unknown top-level metadata",
    origin: "synthetic",
    body: {
      ...HOSTED_CLIENT_BODY,
      "x-vendor-deployment": "eu-central",
      policy_uri: "https://connector.example.com/privacy",
      software_id: "example-suite",
      software_version: "4.2.0",
      tos_uri: "https://connector.example.com/terms",
      unknown_extension_field: { nested: ["value"] },
    },
  },
} as const satisfies Record<string, OAuthClientRegistrationFixture>;

export const OAUTH_CLIENT_REGISTRATION_REJECTION_FIXTURES = {
  clientCredentialsGrant: {
    // An unauthenticated registration cannot self-assert a grant that issues
    // tokens with no user in the loop.
    client: "unauthenticated client requesting client_credentials",
    body: {
      client_name: "Example machine client",
      grant_types: ["client_credentials"],
      redirect_uris: ["https://machine.example.com/oauth/callback"],
      token_endpoint_auth_method: "client_secret_post",
    },
    error: "invalid_client_metadata",
  },
  emptyRedirectUris: {
    client: "authorization_code client sending redirect_uris: []",
    body: {
      client_name: "Example client without a callback",
      grant_types: ["authorization_code"],
      redirect_uris: [],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    error: "invalid_redirect_uri",
  },
} as const satisfies Record<string, OAuthClientRegistrationRejectionFixture>;
