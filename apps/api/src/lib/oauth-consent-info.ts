import { createAuthEndpoint } from "@better-auth/core/api";
import type { SchemaClient } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, sessionMiddleware } from "better-auth/api";
import * as v from "valibot";

import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

type VerifiedOAuthOrigin = `https://${string}`;
const VERIFIED_THIRD_PARTY_ORIGINS: readonly VerifiedOAuthOrigin[] = [];

export const getVerifiedOAuthOrigins = (configuredUrls: readonly string[]) =>
  [...configuredUrls, ...VERIFIED_THIRD_PARTY_ORIGINS].flatMap((value) => {
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

type OAuthConsentClient = Pick<
  SchemaClient,
  "clientId" | "name" | "redirectUris" | "clientDiscoveryId"
>;

export const getOAuthConsentInfo = (
  client: OAuthConsentClient,
  verifiedOrigins: readonly string[],
) => {
  const redirects = (client.redirectUris ?? []).map((uri) => URL.parse(uri));
  const clientUrl = client.clientDiscoveryId
    ? URL.parse(client.clientId)
    : null;
  return {
    client_name: client.name ?? null,
    redirectHosts: [
      ...new Set(redirects.flatMap((url) => (url?.host ? [url.host] : []))),
    ],
    clientIdHost: clientUrl?.host ?? null,
    unverified:
      redirects.length === 0 ||
      redirects.some((url) => !url || !verifiedOrigins.includes(url.origin)) ||
      (client.clientDiscoveryId !== null &&
        client.clientDiscoveryId !== undefined &&
        (!clientUrl || !verifiedOrigins.includes(clientUrl.origin))),
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
            throw new APIError("NOT_FOUND", { message: "Client not found" });
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
