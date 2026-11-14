import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";

import {
  buildMobileClientMetadataDocument,
  type MobileClientMetadataDocument,
  mobileClientMetadataUrl,
} from "@stll/api-contract/mobile-client";
import {
  buildOutlookClientMetadataDocument,
  type OutlookClientMetadataDocument,
  outlookClientMetadataUrl,
} from "@stll/api-contract/outlook-client";
import {
  buildCliClientMetadataDocument,
  type CliClientMetadataDocument,
  cliClientMetadataUrl,
} from "@stll/cli/client-metadata-document";

import { env } from "@/api/env";
import { getAuthIssuerUrl } from "@/api/lib/auth/auth-paths";
import type { FirstPartyOAuthClient } from "@/api/lib/auth/oauth-consent-info";
import {
  buildMcpClientMetadataDocument,
  type McpClientMetadataDocument,
} from "@/api/lib/mcp-upstream/oauth";

/**
 * The CLI's published client document for this deployment. A deployment
 * without an https issuer has none.
 */
export const getCliClientMetadataDocument = ():
  CliClientMetadataDocument | undefined => {
  const clientId = cliClientMetadataUrl(getAuthIssuerUrl());
  return clientId ? buildCliClientMetadataDocument(clientId) : undefined;
};

/**
 * The mobile app's published client document for this deployment. A
 * deployment without an https issuer has none; the app registers a client
 * there.
 */
export const getMobileClientMetadataDocument = ():
  MobileClientMetadataDocument | undefined => {
  const clientId = mobileClientMetadataUrl(getAuthIssuerUrl());
  return clientId ? buildMobileClientMetadataDocument(clientId) : undefined;
};

/**
 * The Outlook add-in's published client document for this deployment. A
 * deployment without an https issuer or a configured task-pane origin has
 * none.
 */
export const getOutlookClientMetadataDocument = ():
  OutlookClientMetadataDocument | undefined => {
  const clientId = outlookClientMetadataUrl(getAuthIssuerUrl());
  const taskPaneOrigin = env.OUTLOOK_ADDIN_ORIGIN;
  return clientId === undefined || taskPaneOrigin === undefined
    ? undefined
    : buildOutlookClientMetadataDocument({ clientId, taskPaneOrigin });
};

/** Every first-party client's document, so none resolves over the network. */
const FIRST_PARTY_CLIENT_DOCUMENTS = {
  cli: getCliClientMetadataDocument,
  mobile: getMobileClientMetadataDocument,
  outlook: getOutlookClientMetadataDocument,
  mcp_connector: buildMcpClientMetadataDocument,
} as const satisfies Record<
  FirstPartyOAuthClient,
  () =>
    | CliClientMetadataDocument
    | MobileClientMetadataDocument
    | OutlookClientMetadataDocument
    | McpClientMetadataDocument
    | undefined
>;

/**
 * Answers requests for client documents Stella publishes itself from the
 * same builders that serve them, so resolving its own clients needs no
 * request to its own public address.
 */
export const withOwnClientDocuments =
  (fetchResource: ClientMetadataResourceFetch): ClientMetadataResourceFetch =>
  async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const own = Object.values(FIRST_PARTY_CLIENT_DOCUMENTS)
      .map((build) => build())
      .find((document) => document?.client_id === url);
    return own ? Response.json(own) : await fetchResource(input, init);
  };
