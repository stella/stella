import {
  ownNativeClientResourceLinks,
  ownNativeClientResources,
} from "@/api/lib/auth/oauth-own-client-links";
import { getMcpBaseUrl } from "@/api/mcp/constants";
import {
  buildApiOAuthResource,
  buildBetterAuthOAuthResources,
  buildEveryClientOAuthResources,
} from "@/api/mcp/resource-policy-contract";
import { isLocalDevOpen } from "@/api/runtime-mode";

/**
 * One source of truth for Better Auth's persisted and runtime OAuth resource
 * policy. Existing 1.6 clients are linked to every MCP audience during the
 * bridge backfill, which preserves the old global `validAudiences`
 * capability. New 1.7 registrations receive an explicit subset at creation
 * time.
 */
export const getBetterAuthOAuthResources = () =>
  buildBetterAuthOAuthResources(getMcpBaseUrl());

/** What every new registration is linked to: the MCP audiences. */
export const getDefaultClientResourceIdentifiers = () =>
  buildEveryClientOAuthResources(getMcpBaseUrl()).map(
    ({ identifier }) => identifier,
  );

/**
 * What a dynamic registration may additionally ask for. The REST API only on
 * a local development server: its http issuer cannot serve the app a metadata
 * document client id, so the app registers there instead. Everywhere else
 * the API resource reaches stella's own apps alone.
 */
export const getAllowedClientResourceIdentifiers = () => [
  ...getDefaultClientResourceIdentifiers(),
  ...(isLocalDevOpen()
    ? [buildApiOAuthResource(getMcpBaseUrl()).identifier]
    : []),
];

/** The extra resources a metadata-document client receives as one of stella's own apps. */
export const getOwnNativeClientResources = (clientId: string) =>
  ownNativeClientResources(getMcpBaseUrl(), clientId);

/**
 * Whether a client may hold REST API tokens: one of stella's own apps, or on a
 * local development server any client, since the app registers itself there.
 * The resource links already confine the grant; this holds the line at the
 * API too, should a link ever be written that the policy did not intend.
 */
export const isApiResourceClient = (clientId: string): boolean =>
  isLocalDevOpen() ||
  ownNativeClientResourceLinks(getMcpBaseUrl()).some(
    (link) => link.clientId === clientId,
  );

/** The REST API's resource identifier, the audience its access tokens carry. */
export const getApiOAuthResourceIdentifier = () =>
  buildApiOAuthResource(getMcpBaseUrl()).identifier;
