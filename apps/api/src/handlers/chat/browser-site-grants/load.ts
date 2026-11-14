import { panic } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import { BROWSER_SITE_GRANTS_MAX } from "@stll/api-contract/browser-site-grants";

import type { SafeDb } from "@/api/db/safe-db";
import { chatBrowserSiteGrants } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";

export type StoredBrowserSiteGrant = {
  id: SafeId<"chatBrowserSiteGrant">;
  origin: string;
};

/** The user's site grants in the active organization, by origin. */
export const loadBrowserSiteGrants = async ({
  organizationId,
  safeDb,
  userId,
}: {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}) =>
  await safeDb(async (tx): Promise<StoredBrowserSiteGrant[]> => {
    const read = await readBounded(
      tx
        .select({
          id: chatBrowserSiteGrants.id,
          origin: chatBrowserSiteGrants.origin,
        })
        .from(chatBrowserSiteGrants)
        .where(
          and(
            eq(chatBrowserSiteGrants.organizationId, organizationId),
            eq(chatBrowserSiteGrants.userId, userId),
          ),
        )
        .orderBy(asc(chatBrowserSiteGrants.origin)),
      BROWSER_SITE_GRANTS_MAX,
    );
    // Creation refuses past the cap under the grant collection lock.
    if (read.type === "overflow") {
      return panic("Stored browser site grants exceed their per-user cap");
    }
    return read.rows;
  });
