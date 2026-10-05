import { createAuthEndpoint } from "@better-auth/core/api";
import type { SchemaClient } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { sessionMiddleware } from "better-auth/api";
import * as v from "valibot";

import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

type HttpsUrl = `https://${string}`;

/**
 * A third-party OAuth client location taken from the vendor's own
 * documentation. `exact` matches the whole URL; `oneSegmentUnder` matches the
 * prefix followed by exactly one path segment the vendor assigns, and only
 * where the vendor documents that form.
 */
type VerifiedClientUrl =
  | { readonly exact: HttpsUrl; readonly source: HttpsUrl }
  | { readonly oneSegmentUnder: `${HttpsUrl}/`; readonly source: HttpsUrl };

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
  { exact: "https://claude.ai/api/mcp/auth_callback", source: CLAUDE_DOCS },
  // ChatGPT: the stable redirect, and the per-connector form it uses otherwise.
  {
    exact: "https://chatgpt.com/connector_platform_oauth_redirect",
    source: CHATGPT_DOCS,
  },
  {
    oneSegmentUnder: "https://chatgpt.com/connector/oauth/",
    source: CHATGPT_DOCS,
  },
  // Microsoft 365 Copilot agents.
  {
    exact: "https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect",
    source: COPILOT_DOCS,
  },
  // Copilot Studio and Power Platform connectors (Microsoft-assigned suffix).
  {
    exact: "https://global.consent.azure-apim.net/redirect",
    source: POWER_PLATFORM_DOCS,
  },
  {
    oneSegmentUnder: "https://global.consent.azure-apim.net/redirect/",
    source: POWER_PLATFORM_DOCS,
  },
  // Gemini Enterprise.
  {
    exact: "https://vertexaisearch.cloud.google.com/oauth-redirect",
    source: GEMINI_ENTERPRISE_DOCS,
  },
];

/** Client ID Metadata Document URLs of widely used third-party clients. */
const VERIFIED_THIRD_PARTY_CLIENT_IDS: readonly VerifiedClientUrl[] = [
  // Claude Code (loopback redirects, attested by this document).
  {
    exact: "https://claude.ai/oauth/claude-code-client-metadata",
    source: CLAUDE_DOCS,
  },
  { exact: "https://chatgpt.com/oauth/client.json", source: CHATGPT_DOCS },
  // Codex CLI (loopback redirects, attested by this document).
  { exact: "https://chatgpt.com/oauth/codex/client.json", source: CODEX_DOCS },
];

const matchesVerifiedUrl = (
  url: URL,
  entries: readonly VerifiedClientUrl[],
): boolean =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.search === "" &&
  url.hash === "" &&
  entries.some((entry) => {
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

const isVerifiedThirdPartyRedirect = (url: URL) =>
  matchesVerifiedUrl(url, VERIFIED_THIRD_PARTY_REDIRECTS);

const isVerifiedThirdPartyClientId = (url: URL) =>
  matchesVerifiedUrl(url, VERIFIED_THIRD_PARTY_CLIENT_IDS);

/** Stella's own origins: every redirect under them is first-party. */
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
 * Whether a client identified by a client metadata document is a known one:
 * its document lives under Stella's own origins or at a documented location.
 */
export const isVerifiedClientMetadataDocument = (
  clientId: string,
  verifiedOrigins: readonly string[],
): boolean => {
  const url = URL.parse(clientId);
  return (
    url?.username === "" &&
    url.password === "" &&
    (verifiedOrigins.includes(url.origin) || isVerifiedThirdPartyClientId(url))
  );
};

type OAuthConsentClient = Pick<
  SchemaClient,
  "clientId" | "name" | "redirectUris" | "clientDiscoveryId"
>;

export const getOAuthConsentInfo = (
  client: OAuthConsentClient,
  verifiedOrigins: readonly string[],
) => {
  const redirects = client.redirectUris
    ? client.redirectUris.map((uri) => URL.parse(uri))
    : [];
  const clientUrl = client.clientDiscoveryId
    ? URL.parse(client.clientId)
    : null;
  return {
    client_name: client.name ?? null,
    redirectHosts: [
      ...new Set(redirects.flatMap((url) => (url?.host ? [url.host] : []))),
    ],
    clientIdHost: clientUrl?.host ?? null,
    unverified: client.clientDiscoveryId
      ? !isVerifiedClientMetadataDocument(client.clientId, verifiedOrigins)
      : redirects.length === 0 ||
        redirects.some(
          (url) =>
            !url ||
            !(
              verifiedOrigins.includes(url.origin) ||
              isVerifiedThirdPartyRedirect(url)
            ),
        ),
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
