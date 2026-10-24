import type { GenericEndpointContext } from "@better-auth/core";
import type { ClientDiscovery } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/** How long a registered client keeps resolving from its last validated
 * metadata document while the document cannot be revalidated. */
export const CIMD_STALE_IF_ERROR_GRACE_MS = Temporal.Duration.from({
  hours: 6,
}).total("milliseconds");

const OAUTH_CLIENT_MODEL = "oauthClient";

/** Declares `oauth_client.metadata_validated_at` to the auth adapter. */
export const CLIENT_METADATA_VALIDATION_SCHEMA_PLUGIN = {
  id: "client-metadata-validation-schema",
  schema: {
    oauthClient: {
      fields: {
        metadataValidatedAt: {
          type: "date",
          input: false,
          required: false,
        },
      },
    },
  },
} satisfies BetterAuthPlugin;

type ClientValidationEvent = {
  client: { clientId: string };
  context: GenericEndpointContext;
};

/**
 * Records that the client's metadata document just passed a fetch and
 * validation. The discovery calls it only after persisting a document it
 * validated, so a stale answer never records one.
 */
export const recordClientMetadataValidated = async ({
  client,
  context,
}: ClientValidationEvent): Promise<void> => {
  // audit: skip - freshness bookkeeping for a discovery-owned client document.
  await context.context.adapter.update({
    model: OAUTH_CLIENT_MODEL,
    where: [{ field: "clientId", value: client.clientId }],
    update: { metadataValidatedAt: new Date() },
  });
};

const readClientMetadataValidatedAt = async (
  ctx: GenericEndpointContext,
  clientId: string,
): Promise<Date | undefined> => {
  const row: unknown = await ctx.context.adapter.findOne({
    model: OAUTH_CLIENT_MODEL,
    where: [{ field: "clientId", value: clientId }],
    select: ["metadataValidatedAt"],
  });
  const validatedAt = isRecord(row) ? row["metadataValidatedAt"] : undefined;
  return validatedAt instanceof Date ? validatedAt : undefined;
};

// The discovery answers a document it could not fetch or validate with
// `invalid_client`, and a fetch its budget refuses with HTTP 429.
const isRevalidationRefusal = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }
  if (error["statusCode"] === 429) {
    return true;
  }
  const body = error["body"];
  return (
    error["statusCode"] === 400 &&
    isRecord(body) &&
    body["error"] === "invalid_client"
  );
};

/**
 * Lets a registered client keep resolving from its stored registration, which
 * the discovery rewrites from every document it validates, when a refetch of
 * its metadata document fails and the last validation is within the grace
 * window. The discovery caches documents per instance, so without this an
 * intermittently unavailable document makes instances answer the same client
 * differently. A client is never created, and never gains anything, from a
 * stale answer: only the last validated registration stands, and a stale
 * answer records no validation, so it cannot extend its own window.
 */
export const withStaleIfError = (
  discovery: ClientDiscovery,
): ClientDiscovery => ({
  ...discovery,
  resolve: async (ctx, clientId, existing) => {
    const resolved = await Result.tryPromise({
      try: async () => await discovery.resolve(ctx, clientId, existing),
      catch: (cause) => cause,
    });
    if (Result.isOk(resolved)) {
      return resolved.value;
    }
    if (
      existing === null ||
      existing.clientDiscoveryId !== discovery.id ||
      !isRevalidationRefusal(resolved.error)
    ) {
      throw resolved.error;
    }
    const validatedAt = await readClientMetadataValidatedAt(ctx, clientId);
    const ageMs =
      validatedAt === undefined
        ? undefined
        : Temporal.Now.instant().epochMilliseconds - validatedAt.getTime();
    if (ageMs === undefined || ageMs > CIMD_STALE_IF_ERROR_GRACE_MS) {
      throw resolved.error;
    }
    logger.warn("auth.client_metadata_stale_served", {
      "oauth.client_id": clientId,
      "oauth.client_metadata_age_seconds": Math.floor(ageMs / 1000),
    });
    return existing;
  },
});
