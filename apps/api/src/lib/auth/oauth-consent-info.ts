import { createAuthEndpoint } from "@better-auth/core/api";
import type { SchemaClient } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { sessionMiddleware } from "better-auth/api";
import { panic } from "better-result";
import * as v from "valibot";

import type {
  McpOAuthScope,
  OAuthConsentClient,
  VerifiedOAuthClientBrand,
} from "@stll/api-contract";
import {
  MOBILE_CLIENT_METADATA_PATH,
  MOBILE_REDIRECT_URIS,
} from "@stll/api-contract/mobile-client";
import {
  CLI_CLIENT_METADATA_PATH,
  LOOPBACK_REDIRECT_PATH,
} from "@stll/cli/client-metadata-document";

import { CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL } from "@/api/http/cache";
import type { OAUTH_REGISTRATION_SCOPE_POLICY } from "@/api/lib/db/oauth-scope-policy";
import { isLoopbackRedirectUri } from "@/api/lib/oauth-loopback-registration";

type HttpsUrl = `https://${string}`;

/** The brands only stella's own origins can verify. */
type FirstPartyBrand = Extract<
  VerifiedOAuthClientBrand,
  "stella" | "stella_ios"
>;

/**
 * A third-party OAuth client location taken from the vendor's own
 * documentation. `exact` matches the whole URL; `oneSegmentUnder` matches the
 * prefix followed by exactly one path segment the vendor assigns, and only
 * where the vendor documents that form.
 */
type VerifiedClientLocation =
  { readonly exact: HttpsUrl } | { readonly oneSegmentUnder: `${HttpsUrl}/` };

type VerifiedClientUrl = VerifiedClientLocation & {
  readonly source: HttpsUrl;
  /**
   * The product, when the location identifies the client itself. A shared
   * platform redirect that serves connectors anyone can publish proves the
   * platform, not the publisher, so it verifies without naming a product.
   */
  readonly brand: Exclude<VerifiedOAuthClientBrand, FirstPartyBrand> | null;
};

const CLAUDE_DOCS =
  "https://claude.com/docs/connectors/building/authentication";
const CHATGPT_DOCS = "https://developers.openai.com/plugins/build/auth";
const CODEX_DOCS = "https://learn.chatgpt.com/docs/extend/mcp?surface=cli";
const COPILOT_DOCS =
  "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth";
const POWER_PLATFORM_DOCS =
  "https://learn.microsoft.com/en-us/connectors/custom-connectors/azure-active-directory-authentication";
const GEMINI_ENTERPRISE_DOCS =
  "https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server";

/** Redirect URIs of widely used third-party clients. */
const VERIFIED_THIRD_PARTY_REDIRECTS: readonly VerifiedClientUrl[] = [
  // Claude on the web, desktop and mobile.
  {
    exact: "https://claude.ai/api/mcp/auth_callback",
    source: CLAUDE_DOCS,
    brand: "claude",
  },
  // ChatGPT: the stable redirect, and the per-connector form it uses otherwise.
  {
    exact: "https://chatgpt.com/connector_platform_oauth_redirect",
    source: CHATGPT_DOCS,
    brand: "chatgpt",
  },
  {
    oneSegmentUnder: "https://chatgpt.com/connector/oauth/",
    source: CHATGPT_DOCS,
    brand: "chatgpt",
  },
  // Microsoft 365 Copilot agents.
  {
    exact: "https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect",
    source: COPILOT_DOCS,
    brand: null,
  },
  // Copilot Studio and Power Platform connectors (Microsoft-assigned suffix).
  {
    exact: "https://global.consent.azure-apim.net/redirect",
    source: POWER_PLATFORM_DOCS,
    brand: null,
  },
  {
    oneSegmentUnder: "https://global.consent.azure-apim.net/redirect/",
    source: POWER_PLATFORM_DOCS,
    brand: null,
  },
  // Gemini Enterprise.
  {
    exact: "https://vertexaisearch.cloud.google.com/oauth-redirect",
    source: GEMINI_ENTERPRISE_DOCS,
    brand: null,
  },
];

type VerifiedClientId = VerifiedClientUrl & {
  /**
   * The most a client identified by this document may be granted: "elevated"
   * keeps the scopes self-registered clients never get, "open" withholds them
   * as for a registered client.
   */
  readonly scopePolicy: (typeof OAUTH_REGISTRATION_SCOPE_POLICY)[McpOAuthScope];
};

/** Client ID Metadata Document URLs of widely used third-party clients. */
const VERIFIED_THIRD_PARTY_CLIENT_IDS: readonly VerifiedClientId[] = [
  // Claude on the web, desktop and mobile: the document Anthropic hosts for
  // the hosted apps, whose only redirect is the hosted callback above. It may
  // be granted what Claude is granted when it registers that callback.
  {
    exact: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    source: CLAUDE_DOCS,
    brand: "claude",
    scopePolicy: "open",
  },
  // Claude Code (loopback redirects, attested by this document).
  {
    exact: "https://claude.ai/oauth/claude-code-client-metadata",
    source: CLAUDE_DOCS,
    brand: "claude_code",
    scopePolicy: "elevated",
  },
  {
    exact: "https://chatgpt.com/oauth/client.json",
    source: CHATGPT_DOCS,
    brand: "chatgpt",
    scopePolicy: "elevated",
  },
  // Codex CLI (loopback redirects, attested by this document).
  {
    exact: "https://chatgpt.com/oauth/codex/client.json",
    source: CODEX_DOCS,
    brand: "codex",
    scopePolicy: "elevated",
  },
];

const findVerifiedUrl = <Entry extends VerifiedClientUrl>(
  url: URL,
  entries: readonly Entry[],
): Entry | undefined => {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return entries.find((entry) => {
    if ("exact" in entry) {
      return url.href === entry.exact;
    }
    if (!url.href.startsWith(entry.oneSegmentUnder)) {
      return false;
    }
    const segment = url.href.slice(entry.oneSegmentUnder.length);
    return (
      /^[A-Za-z0-9._~-]+$/u.test(segment) && segment !== "." && segment !== ".."
    );
  });
};

/**
 * How a first-party client's redirect URI is checked.
 *
 * - `loopback`: RFC 8252 §7.3, an http loopback host on any port, at `path`.
 * - `exact`: one of `uris`, as written (private-use schemes).
 * - `document_origin`: `path` on the origin that publishes the client's
 *   document.
 */
type FirstPartyRedirect =
  | { readonly type: "loopback"; readonly path: `/${string}` }
  | { readonly type: "exact"; readonly uris: readonly string[] }
  | { readonly type: "document_origin"; readonly path: `/${string}` };

type FirstPartyOAuthClientEntry = {
  /**
   * The client's public id is this path on one of stella's own origins: the
   * URL of the client metadata document stella publishes for it, which the
   * provider resolves in process (`withOwnClientDocuments`).
   */
  readonly documentPath: `/${string}`;
  readonly redirect: FirstPartyRedirect;
  readonly brand: FirstPartyBrand;
};

/**
 * stella's own OAuth clients, which may hold elevated scopes. Only these are
 * first-party: a client is one when its id is exactly an entry's document URL,
 * never by its name or redirects, so a dynamically registered client (whose
 * id the server generates) never is.
 * The desktop app signs in with a device-bound link grant, not OAuth, so it
 * has no entry.
 */
export const FIRST_PARTY_OAUTH_CLIENTS = {
  cli: {
    documentPath: CLI_CLIENT_METADATA_PATH,
    redirect: { type: "loopback", path: LOOPBACK_REDIRECT_PATH },
    brand: "stella",
  },
  mobile: {
    documentPath: MOBILE_CLIENT_METADATA_PATH,
    redirect: { type: "exact", uris: MOBILE_REDIRECT_URIS },
    brand: "stella_ios",
  },
  // stella connecting to an MCP server as a client.
  mcp_connector: {
    documentPath: "/v1/mcp/oauth/client-metadata.json",
    redirect: { type: "document_origin", path: "/v1/mcp/oauth/callback" },
    brand: "stella",
  },
} as const satisfies Record<string, FirstPartyOAuthClientEntry>;

export type FirstPartyOAuthClient = keyof typeof FIRST_PARTY_OAUTH_CLIENTS;

type FirstPartyOAuthClientMatch = {
  readonly entry: (typeof FIRST_PARTY_OAUTH_CLIENTS)[FirstPartyOAuthClient];
  /** The stella origin publishing the client's document. */
  readonly origin: string;
};

/**
 * The first-party client `clientId` names: exactly an entry's document URL on
 * one of stella's own origins.
 */
export const findFirstPartyOAuthClient = (
  clientId: string,
  verifiedOrigins: readonly string[],
): FirstPartyOAuthClientMatch | undefined => {
  const url = URL.parse(clientId);
  if (!url || !verifiedOrigins.includes(url.origin)) {
    return undefined;
  }
  const entry = Object.values(FIRST_PARTY_OAUTH_CLIENTS).find(
    ({ documentPath }) => clientId === new URL(documentPath, url.origin).href,
  );
  return entry && { entry, origin: url.origin };
};

/** Whether a first-party client may be sent its code at `redirectUri`. */
export const isFirstPartyRedirectAllowed = (
  { entry: { redirect }, origin }: FirstPartyOAuthClientMatch,
  redirectUri: string,
): boolean => {
  switch (redirect.type) {
    case "loopback": {
      const url = URL.parse(redirectUri);
      return (
        url !== null &&
        isLoopbackRedirectUri(redirectUri) &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === redirect.path &&
        url.search === "" &&
        url.hash === ""
      );
    }
    case "exact":
      return redirect.uris.includes(redirectUri);
    case "document_origin":
      return redirectUri === new URL(redirect.path, origin).href;
    default:
      redirect satisfies never;
      return panic("Unhandled first-party redirect shape");
  }
};

/** stella's own https origins, which publish its first-party client documents. */
export const getVerifiedOAuthOrigins = (configuredUrls: readonly string[]) =>
  configuredUrls.flatMap((value) => {
    const url = URL.parse(value);
    if (
      !url ||
      url.protocol !== "https:" ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "[::1]" ||
      url.hostname.startsWith("127.")
    ) {
      return [];
    }
    return [url.origin];
  });

/**
 * Whether a client identified by a client metadata document may hold elevated
 * scopes: it is a first-party client, or its document is at a documented
 * location whose entry allows them.
 */
export const mayMetadataDocumentClientHoldElevatedScopes = (
  clientId: string,
  verifiedOrigins: readonly string[],
): boolean => {
  if (findFirstPartyOAuthClient(clientId, verifiedOrigins)) {
    return true;
  }
  const url = URL.parse(clientId);
  return (
    url !== null &&
    findVerifiedUrl(url, VERIFIED_THIRD_PARTY_CLIENT_IDS)?.scopePolicy ===
      "elevated"
  );
};

/** The brand a location verifies, `"unbranded"`, or `null` when it verifies none. */
type LocationEvidence = VerifiedOAuthClientBrand | "unbranded" | null;

const thirdPartyEvidence = (
  url: URL | null,
  entries: readonly VerifiedClientUrl[],
): LocationEvidence => {
  const entry = url ? findVerifiedUrl(url, entries) : undefined;
  if (!entry) {
    return null;
  }
  return entry.brand ?? "unbranded";
};

type RegisteredConsentClient = Pick<
  SchemaClient,
  "clientId" | "name" | "redirectUris" | "clientDiscoveryId"
>;

/**
 * A metadata document client is first-party when its id is a first-party
 * document URL and every redirect it holds fits that client's shape;
 * otherwise its document must be at a documented third-party location.
 */
const documentEvidence = (
  client: RegisteredConsentClient,
  clientUrl: URL | null,
  verifiedOrigins: readonly string[],
): LocationEvidence => {
  const firstParty = findFirstPartyOAuthClient(
    client.clientId,
    verifiedOrigins,
  );
  if (!firstParty) {
    return thirdPartyEvidence(clientUrl, VERIFIED_THIRD_PARTY_CLIENT_IDS);
  }
  const redirectsFit = client.redirectUris?.every((uri) =>
    isFirstPartyRedirectAllowed(firstParty, uri),
  );
  return redirectsFit === true ? firstParty.entry.brand : null;
};

/**
 * Verified only when every location is, and branded only when they all name
 * the same product. The registered name travels only with an unbranded
 * client, as its own claim.
 */
const consentClient = (
  evidence: readonly LocationEvidence[],
  claimedName: string | null,
): OAuthConsentClient => {
  const brands = new Set(evidence);
  if (brands.size === 0 || brands.has(null)) {
    return { type: "unverified", name: claimedName };
  }
  const [onlyBrand] = brands;
  if (
    brands.size === 1 &&
    onlyBrand !== undefined &&
    onlyBrand !== null &&
    onlyBrand !== "unbranded"
  ) {
    return { type: "verified", brand: onlyBrand };
  }
  return { type: "verified_unbranded", name: claimedName };
};

/**
 * Where a redirect sends the authorization code, as the consent screen shows
 * it: the host of an http(s) redirect, and the scheme (with its authority, if
 * any) of a private-use one, so a look-alike client name cannot hide which
 * application receives the code.
 */
const redirectTarget = (url: URL): string =>
  url.protocol === "http:" || url.protocol === "https:"
    ? url.host
    : `${url.protocol}${url.host ? `//${url.host}` : ""}`;

/**
 * What the consent screen may claim about a client. A client identified by a
 * metadata document is verified by its document (see `documentEvidence`); any
 * other client by every one of its redirect URIs, and only as a documented
 * third party, so a registered client is never first-party. The registered
 * name never selects a brand.
 */
export const getOAuthConsentInfo = (
  client: RegisteredConsentClient,
  verifiedOrigins: readonly string[],
) => {
  const redirects = client.redirectUris
    ? client.redirectUris.map((uri) => URL.parse(uri))
    : [];
  const clientUrl = client.clientDiscoveryId
    ? URL.parse(client.clientId)
    : null;
  const evidence = client.clientDiscoveryId
    ? [documentEvidence(client, clientUrl, verifiedOrigins)]
    : redirects.map((url) =>
        thirdPartyEvidence(url, VERIFIED_THIRD_PARTY_REDIRECTS),
      );
  return {
    client: consentClient(evidence, client.name || null),
    redirectTargets: [
      ...new Set(
        redirects.flatMap((url) => {
          const target = url ? redirectTarget(url) : "";
          return target ? [target] : [];
        }),
      ),
    ],
    clientIdHost: clientUrl?.host ?? null,
  };
};

export const createOAuthConsentInfoPlugin = (
  configuredUrls: readonly string[],
) =>
  ({
    id: "stella-oauth-consent-info",
    endpoints: {
      getOAuthConsentInfo: createAuthEndpoint(
        "/oauth2/consent-info",
        {
          method: "GET",
          use: [sessionMiddleware],
          query: v.object({ client_id: v.string() }),
        },
        async (ctx) => {
          const client = await ctx.context.adapter.findOne<SchemaClient>({
            model: "oauthClient",
            where: [{ field: "clientId", value: ctx.query.client_id }],
          });
          if (!client || client.disabled) {
            return ctx.json(
              { message: "Client not found" },
              {
                status: 404,
                headers: { [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL },
              },
            );
          }
          ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
          return ctx.json(
            getOAuthConsentInfo(
              client,
              getVerifiedOAuthOrigins(configuredUrls),
            ),
          );
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
