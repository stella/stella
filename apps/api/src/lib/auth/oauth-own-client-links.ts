/**
 * The resources stella's own native apps hold beyond the MCP audiences every
 * client registration receives.
 *
 * The REST API resource is linked to these clients alone. Two writers keep it
 * that way and both read this module: the auth adapter links it in the same
 * transaction that first stores the app's client from its metadata document,
 * and the deploy repair links it for an app client that already exists.
 * Nothing else ever links it, so a client connected over MCP cannot hold a
 * token the REST API accepts.
 *
 * Reads no environment: the deploy repair runs with a database-only one and
 * passes the origin it reads off the stored resources.
 */

import { type SQL, sql } from "drizzle-orm";

import { apiOAuthResourceUrl } from "@stll/api-contract/api-oauth-resource";
import { mobileClientMetadataUrl } from "@stll/api-contract/mobile-client";

export type OwnNativeClientResourceLink = {
  readonly clientId: string;
  readonly resourceId: string;
};

/**
 * Every own-app link for a deployment origin. Empty without https: a metadata
 * document client id must be https, so there is no app client to link.
 */
export const ownNativeClientResourceLinks = (
  origin: string,
): readonly OwnNativeClientResourceLink[] => {
  const mobileClientId = mobileClientMetadataUrl(origin);
  return mobileClientId === undefined
    ? []
    : [{ clientId: mobileClientId, resourceId: apiOAuthResourceUrl(origin) }];
};

/** The extra resources a client registration receives because it is one of stella's own apps. */
export const ownNativeClientResources = (
  origin: string,
  clientId: string,
): readonly string[] =>
  ownNativeClientResourceLinks(origin)
    .filter((link) => link.clientId === clientId)
    .map(({ resourceId }) => resourceId);

/**
 * Links each own app client that already exists to its extra resources.
 * Idempotent: an existing link is left alone and an absent client links
 * nothing, since its registration links it when it first appears.
 */
export const linkOwnNativeClientResources = async (
  transaction: { readonly execute: (query: SQL) => Promise<unknown> },
  origin: string,
): Promise<void> => {
  const links = ownNativeClientResourceLinks(origin);
  if (links.length === 0) {
    return;
  }
  // audit: skip - deploy repair writes OAuth resource policy, which no actor owns
  await transaction.execute(sql`
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(links)}::text::jsonb)
          AS row_value("clientId" text, "resourceId" text)
    )
    INSERT INTO oauth_client_resource (id, client_id, resource_id)
    SELECT gen_random_uuid()::text, input."clientId", input."resourceId"
      FROM input
      JOIN oauth_client client ON client.client_id = input."clientId"
      JOIN oauth_resource resource ON resource.identifier = input."resourceId"
    ON CONFLICT (client_id, resource_id) DO NOTHING
  `);
};
