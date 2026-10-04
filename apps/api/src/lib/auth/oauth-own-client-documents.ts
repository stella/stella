import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";

import {
  buildCliClientMetadataDocument,
  cliClientMetadataUrl,
  type CliClientMetadataDocument,
} from "@stll/cli/client-metadata-document";

import { getAuthIssuerUrl } from "@/api/lib/auth/auth-paths";

/**
 * The CLI's published client document for this deployment. A deployment
 * without an https issuer has none; the CLI registers a client there.
 */
export const getCliClientMetadataDocument = ():
  | CliClientMetadataDocument
  | undefined => {
  const clientId = cliClientMetadataUrl(getAuthIssuerUrl());
  return clientId ? buildCliClientMetadataDocument(clientId) : undefined;
};

/**
 * Answers requests for client documents Stella publishes itself from the
 * same builder that serves them, so resolving its own clients needs no
 * request to its own public address.
 */
export const withOwnClientDocuments =
  (fetchResource: ClientMetadataResourceFetch): ClientMetadataResourceFetch =>
  async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const own = getCliClientMetadataDocument();
    return own?.client_id === url
      ? Response.json(own)
      : await fetchResource(input, init);
  };
