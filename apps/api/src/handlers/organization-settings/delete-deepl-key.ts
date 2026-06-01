import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { organizationSettings } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const config = {
  permissions: { organizationSettings: ["update"] },
} satisfies HandlerConfig;

/** Clear the org's stored DeepL API key. */
const deleteDeepLKey = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(organizationSettings)
          .set({
            deeplApiKeyEncrypted: null,
            deeplApiKeyIv: null,
            updatedAt: new Date(),
          })
          .where(
            eq(
              organizationSettings.organizationId,
              session.activeOrganizationId,
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: { field: "deeplApiKey", change: "cleared" },
        });
      }),
    );

    return Result.ok({ deleted: true });
  },
);

export default deleteDeepLKey;
