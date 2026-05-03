import { Result } from "better-result";
import { asc, eq } from "drizzle-orm";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { organizationSettings: ["update"] },
} satisfies HandlerConfig;

const readAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            canonical: anonymizationBlacklistEntries.canonical,
            enabled: anonymizationBlacklistEntries.enabled,
            id: anonymizationBlacklistEntries.id,
            label: anonymizationBlacklistEntries.label,
            variants: anonymizationBlacklistEntries.variants,
          })
          .from(anonymizationBlacklistEntries)
          .where(
            eq(
              anonymizationBlacklistEntries.organizationId,
              session.activeOrganizationId,
            ),
          )
          .orderBy(asc(anonymizationBlacklistEntries.canonical)),
      ),
    );

    return Result.ok({ entries: rows });
  },
);

export default readAnonymizationBlacklist;
