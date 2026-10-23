import type { ClientDiscovery } from "@better-auth/oauth-provider";
import { Result } from "better-result";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { oauthClient } from "@/api/db/auth-schema";
import type { RootDatabase } from "@/api/db/root";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/** How long a registered client keeps resolving from its last validated
 * metadata document while the document cannot be revalidated. */
export const CIMD_STALE_IF_ERROR_GRACE_SECONDS = 6 * 60 * 60;

export type CimdMetadataValidationStore = {
  /** Records that the client's document just passed a fetch and validation. */
  recordValidated: (clientId: string) => Promise<void>;
  /** Seconds since the last recorded validation, or undefined when none is. */
  readValidationAgeSeconds: (clientId: string) => Promise<number | undefined>;
};

/**
 * Persists validations on `oauth_client.metadata_validated_at`. The database
 * clock stamps and measures them, so instances agree on one grace window
 * whatever their own clocks say. The auth owner passes its connection.
 */
export const createCimdMetadataValidationStore = (
  db: RootDatabase,
): CimdMetadataValidationStore => ({
  recordValidated: async (clientId) => {
    // audit: skip - freshness bookkeeping for a discovery-owned client document.
    await db
      .update(oauthClient)
      .set({ metadataValidatedAt: sql`now()` })
      .where(eq(oauthClient.clientId, clientId));
  },
  readValidationAgeSeconds: async (clientId) => {
    const row = (
      await db
        .select({
          ageSeconds: sql<number>`extract(epoch from now() - ${oauthClient.metadataValidatedAt})::float8`,
        })
        .from(oauthClient)
        .where(
          and(
            eq(oauthClient.clientId, clientId),
            isNotNull(oauthClient.metadataValidatedAt),
          ),
        )
        .limit(1)
    ).at(0);
    return row?.ageSeconds;
  },
});

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
  store: CimdMetadataValidationStore,
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
    const ageSeconds = await store.readValidationAgeSeconds(clientId);
    if (
      ageSeconds === undefined ||
      ageSeconds > CIMD_STALE_IF_ERROR_GRACE_SECONDS
    ) {
      throw resolved.error;
    }
    logger.warn("auth.client_metadata_stale_served", {
      "oauth.client_id": clientId,
      "oauth.client_metadata_age_seconds": Math.floor(ageSeconds),
    });
    return existing;
  },
});
