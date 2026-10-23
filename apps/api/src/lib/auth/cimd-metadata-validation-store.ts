import { and, eq, isNotNull, sql } from "drizzle-orm";

import { oauthClient } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { CimdMetadataValidationStore } from "@/api/lib/auth/cimd-stale-if-error";

// The database clock stamps and measures validations, so instances agree on
// one grace window whatever their own clocks say.
export const cimdMetadataValidationStore: CimdMetadataValidationStore = {
  recordValidated: async (clientId) => {
    // audit: skip - freshness bookkeeping for a discovery-owned client document.
    await rootDb
      .update(oauthClient)
      .set({ metadataValidatedAt: sql`now()` })
      .where(eq(oauthClient.clientId, clientId));
  },
  readValidationAgeSeconds: async (clientId) => {
    const row = (
      await rootDb
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
};
