import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { organizationSettings } from "@/api/db/schema";
import { invalidateOrgAIConfig } from "@/api/lib/ai-config-cache";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { organizationSettings: ["update"] },
} satisfies HandlerConfig;

/**
 * Remove the org's AI config. Nulls the encrypted columns
 * so the org reverts to instance-level AI defaults.
 */
const deleteAIConfig = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(organizationSettings)
          .set({
            aiConfigEncrypted: null,
            aiConfigIv: null,
            updatedAt: new Date(),
          })
          .where(
            eq(
              organizationSettings.organizationId,
              session.activeOrganizationId,
            ),
          ),
      ),
    );

    invalidateOrgAIConfig(session.activeOrganizationId);

    return Result.ok({ deleted: true });
  },
);

export default deleteAIConfig;
