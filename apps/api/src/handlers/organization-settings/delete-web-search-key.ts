import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  webSearchKeyAuditField,
  webSearchKeyColumns,
  WEB_SEARCH_KEY_KINDS,
} from "@/api/lib/web-search/keys";

const deleteWebSearchKeyBody = t.Object({
  kind: t.UnionEnum(WEB_SEARCH_KEY_KINDS),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
  body: deleteWebSearchKeyBody,
} satisfies HandlerConfig;

/** Clear one of the org's stored web-search BYOK keys. */
const deleteWebSearchKey = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const { kind } = body;

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(organizationSettings)
          .set({ ...webSearchKeyColumns(kind, null), updatedAt: new Date() })
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
          metadata: { field: webSearchKeyAuditField(kind), change: "cleared" },
        });
      }),
    );

    return Result.ok({ kind, deleted: true });
  },
);

export default deleteWebSearchKey;
